import { realpathSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { classifyGraftFile, type FileStatus } from "../core/classify";
import { parseConflictFile, reconstructLocal, type FileSegment } from "../core/conflicts";
import { ensureCacheRepo, ensureCommit, gitText, logRange, readFileAt } from "../core/git";
import { isBinary, readFileIfExists, sha256 } from "../core/hash";
import type { Graft, GraftFile, Intent, Manifest, PendingKind } from "../core/manifest";
import { hydratePendingTarget } from "../core/pending";
import { analyzeResolution, type RegionStatus } from "../core/review";
import { cacheRoot, managedFilePath, projectPath, upstreamPath } from "../core/workspace";

export interface UiIntent {
  id: string;
  date: string;
  description: string;
  files: string[];
}

export interface UiCommit {
  sha: string;
  subject: string;
}

export type UiSegment =
  | { type: "text"; text: string }
  | { type: "conflict"; index: number; local: string; base: string; upstream: string };

export interface UiReviewRegion {
  /** Ordinal among all decision regions of this file, resolved or not. */
  index: number;
  status: RegionStatus;
  /** Text currently occupying the region in the working file. */
  text: string;
  local: string;
  base: string;
  upstream: string;
  /** Character range of `text` within `working`. */
  start: number;
  end: number;
  /** 1-based line where the region starts in the working file. */
  line: number;
}

export interface UiPending {
  kind: PendingKind;
  /** Short human explanation of what happened and what a decision means. */
  headline: string;
  detail: string;
  fromSha: string | null;
  toSha: string;
  brief: string | null;
  binary: boolean;
  /** Old upstream content both sides started from (null: missing/binary). */
  base: string | null;
  /** New upstream content (null: upstream deleted the file, or binary). */
  upstream: string | null;
  /** Your adapted version (null: deleted locally, or binary). */
  local: string | null;
  /** True when `local` was recovered byte-exact (project git or disk hash match). */
  localExact: boolean;
  /** Current on-disk content (with diff3 markers for content conflicts). */
  working: string | null;
  /** Parsed diff3 segments of `working` for content conflicts, else null. */
  segments: UiSegment[] | null;
  /**
   * Decision regions aligned against the working file — including regions
   * already resolved (by an agent, an editor, or this UI). Null when the
   * file cannot be analyzed; the client falls back to `segments`.
   */
  review: UiReviewRegion[] | null;
  conflictsRemaining: number;
  upstreamCommits: UiCommit[];
}

export interface UiFile {
  path: string;
  rel: string;
  status: FileStatus;
  needsIntent: boolean;
  intents: UiIntent[];
  pending: UiPending | null;
}

export interface UiGraft {
  id: string;
  name: string;
  url: string;
  remoteRef: string;
  sourcePath: string;
  dest: string;
  pinnedSha: string;
  files: UiFile[];
  pendingCount: number;
}

export interface UiSummary {
  grafts: number;
  tracked: number;
  conflicts: number;
  warnings: number;
  mergedClean: number;
  needsNote: number;
}

export interface UiState {
  schemaVersion: 1;
  generatedAt: string;
  project: { name: string; root: string };
  summary: UiSummary;
  grafts: UiGraft[];
}

const PENDING_COPY: Record<PendingKind, { headline: string; detail: string }> = {
  "content-conflict": {
    headline: "Upstream and your version changed the same lines",
    detail:
      "Regraft merged everything that did not overlap. The remaining regions need a decision: keep your side, take upstream, or write the combination yourself.",
  },
  "legacy-conflict": {
    headline: "Unresolved conflict from an earlier version of regraft",
    detail: "Reconcile the marked regions, then accept the result.",
  },
  "binary-conflict": {
    headline: "Binary file changed both locally and upstream",
    detail: "Binary content cannot be merged. Keep your file or take the upstream one.",
  },
  "upstream-deleted": {
    headline: "Upstream deleted this file you adapted",
    detail: "Upstream no longer ships this file. Keep your local copy or delete it to follow upstream.",
  },
  "local-deleted": {
    headline: "You deleted this file, upstream changed it",
    detail: "The file is intentionally absent locally while upstream keeps changing it. Keep the deletion or restore the upstream version.",
  },
  "destination-collision": {
    headline: "New upstream file collides with your local file",
    detail: "Upstream added a file at a path you already use. Keep your file or replace it with the upstream one.",
  },
  "ownership-unknown": {
    headline: "Legacy manifest cannot prove this file's origin",
    detail: "Regraft cannot tell whether this upstream file was originally excluded. Review it and decide explicitly.",
  },
};

function presentIntents(manifest: Manifest, intentIds: readonly string[]): UiIntent[] {
  const byId = new Map(manifest.intents.map((intent) => [intent.id, intent] as const));
  const result: UiIntent[] = [];
  for (const id of intentIds) {
    const intent = byId.get(id);
    if (intent) result.push(toUiIntent(intent));
  }
  return result;
}

function toUiIntent(intent: Intent): UiIntent {
  return {
    id: intent.id,
    date: intent.date,
    description: intent.description,
    files: intent.targets.map((target) => target.path),
  };
}

function textOrNull(buffer: Buffer | null): { text: string | null; binary: boolean } {
  if (buffer === null) return { text: null, binary: false };
  if (isBinary(buffer)) return { text: null, binary: true };
  return { text: buffer.toString("utf8"), binary: false };
}

function readUpstreamText(cache: string, url: string, remoteRef: string, sha: string | null, path: string): Buffer | null {
  if (sha === null) return null;
  try {
    ensureCommit(cache, url, sha, remoteRef);
    return readFileAt(cache, sha, path);
  } catch {
    return null;
  }
}

/**
 * Recover the byte-exact pre-pull local version from the project's own git
 * history (HEAD, then index). regraft hashes content with sha256, so a
 * candidate counts only when its digest matches the recorded local hash.
 */
function recoverExactLocal(root: string, path: string, expectedHash: string | null): string | null {
  if (expectedHash === null) return null;
  let toplevel: string;
  let realRoot: string;
  try {
    toplevel = gitText(["rev-parse", "--show-toplevel"], { cwd: root }).trim();
    realRoot = realpathSync(resolve(root));
  } catch {
    return null;
  }
  // git prints the physical path; compare like with like on symlinked temp dirs.
  const rel = relative(resolve(toplevel), resolve(realRoot, path)).split(sep).join("/");
  if (rel.startsWith("..")) return null;
  for (const spec of [`HEAD:${rel}`, `:0:${rel}`]) {
    try {
      const candidate = gitText(["show", spec], { cwd: toplevel });
      if (sha256(candidate) === expectedHash) return candidate;
    } catch {
      // candidate unavailable; try the next one
    }
  }
  return null;
}

function toUiSegments(working: string): { segments: UiSegment[]; conflictsRemaining: number } {
  const model = parseConflictFile(working);
  const segments = model.segments.map((segment: FileSegment): UiSegment => {
    if (segment.type === "text") return { type: "text", text: segment.text };
    return {
      type: "conflict",
      index: segment.index,
      local: segment.local,
      base: segment.base,
      upstream: segment.upstream,
    };
  });
  return { segments, conflictsRemaining: model.conflictCount };
}

export interface PendingSides {
  base: string | null;
  upstream: string | null;
  local: string | null;
  localExact: boolean;
  working: string | null;
  binary: boolean;
}

/**
 * Read all three sides plus the current working content for a pending file.
 * "Your version" prefers a byte-exact recovery, falling back to collapsing
 * every conflict region to its local side.
 */
export function readPendingSides(root: string, graft: Graft, rel: string, file: GraftFile): PendingSides {
  const pending = file.pending;
  if (!pending) throw new Error(`"${rel}" has no pending update.`);
  try {
    hydratePendingTarget(root, graft, rel, file);
  } catch {
    // Offline or unreachable upstream: continue with what is known locally.
  }

  const cache = ensureCacheRepo(cacheRoot(root), graft.url);
  const sourceFile = upstreamPath(graft.path, rel);
  const path = projectPath(graft.dest, rel);

  const baseBuffer = readUpstreamText(cache, graft.url, graft.remoteRef, pending.fromSha, sourceFile);
  const upstreamBuffer =
    pending.targetHash === null ? null : readUpstreamText(cache, graft.url, graft.remoteRef, pending.toSha, sourceFile);
  const workingBuffer = readFileIfExists(managedFilePath(root, path));

  const base = textOrNull(baseBuffer);
  const upstream = textOrNull(upstreamBuffer);
  const working = textOrNull(workingBuffer);
  const binary = base.binary || upstream.binary || working.binary || pending.kind === "binary-conflict";
  const isContentConflict = pending.kind === "content-conflict" || pending.kind === "legacy-conflict";

  let local: string | null = null;
  let localExact = false;
  if (!binary) {
    if (workingBuffer !== null && pending.observedLocalHash !== null && sha256(workingBuffer) === pending.observedLocalHash) {
      local = working.text;
      localExact = true;
    } else {
      const recovered = recoverExactLocal(root, path, pending.observedLocalHash);
      if (recovered !== null) {
        local = recovered;
        localExact = true;
      } else if (isContentConflict && working.text !== null) {
        local = reconstructLocal(working.text);
        localExact = false;
      } else if (pending.observedLocalHash === null) {
        local = null;
        localExact = true; // deleted locally: "no content" is exact
      } else {
        local = working.text;
        localExact = false;
      }
    }
  }

  return { base: base.text, upstream: upstream.text, local, localExact, working: working.text, binary };
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/**
 * Decision regions for a content conflict, aligned against the working file.
 * Only computed when "your version" is byte-exact — otherwise resolved
 * regions could be misclassified — and null when alignment fails.
 */
export function reviewRegions(sides: PendingSides): UiReviewRegion[] | null {
  if (
    sides.binary ||
    !sides.localExact ||
    sides.base === null ||
    sides.upstream === null ||
    sides.local === null ||
    sides.working === null
  ) {
    return null;
  }
  const analysis = analyzeResolution({
    base: sides.base,
    local: sides.local,
    upstream: sides.upstream,
    working: sides.working,
  });
  if (!analysis) return null;
  const working = sides.working;
  return analysis.regions.map((region) => ({
    index: region.index,
    status: region.status,
    text: region.text,
    local: region.local,
    base: region.base,
    upstream: region.upstream,
    start: region.start,
    end: region.end,
    line: lineAt(working, region.start),
  }));
}

function buildPending(root: string, graft: Graft, rel: string, file: GraftFile): UiPending | null {
  const pending = file.pending;
  if (!pending) return null;

  const sides = readPendingSides(root, graft, rel, file);
  const cache = ensureCacheRepo(cacheRoot(root), graft.url);
  const sourceFile = upstreamPath(graft.path, rel);
  const copy = PENDING_COPY[pending.kind];

  const isContentConflict = pending.kind === "content-conflict" || pending.kind === "legacy-conflict";
  let segments: UiSegment[] | null = null;
  let conflictsRemaining = 0;
  if (isContentConflict && sides.working !== null) {
    const parsed = toUiSegments(sides.working);
    segments = parsed.segments;
    conflictsRemaining = parsed.conflictsRemaining;
  }
  const review = isContentConflict ? reviewRegions(sides) : null;

  let upstreamCommits: UiCommit[] = [];
  if (pending.fromSha !== null) {
    upstreamCommits = logRange(cache, pending.fromSha, pending.toSha, sourceFile)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("("))
      .map((line) => {
        const space = line.indexOf(" ");
        return space === -1 ? { sha: line, subject: "" } : { sha: line.slice(0, space), subject: line.slice(space + 1) };
      });
  }

  return {
    kind: pending.kind,
    headline: copy.headline,
    detail: copy.detail,
    fromSha: pending.fromSha,
    toSha: pending.toSha,
    brief: pending.brief,
    binary: sides.binary,
    base: sides.base,
    upstream: sides.upstream,
    local: sides.local,
    localExact: sides.localExact,
    working: sides.working,
    segments,
    review,
    conflictsRemaining,
    upstreamCommits,
  };
}

export function buildUiState(root: string, manifest: Manifest): UiState {
  const grafts: UiGraft[] = [];
  const summary: UiSummary = {
    grafts: manifest.grafts.length,
    tracked: 0,
    conflicts: 0,
    warnings: 0,
    mergedClean: 0,
    needsNote: 0,
  };

  for (const graft of manifest.grafts) {
    const files: UiFile[] = [];
    let pendingCount = 0;
    for (const [rel, file] of Object.entries(graft.files).sort(([a], [b]) => a.localeCompare(b))) {
      const path = projectPath(graft.dest, rel);
      const status = classifyGraftFile(root, graft, rel, file);
      summary.tracked += 1;
      if (status === "conflict-unresolved") summary.conflicts += 1;
      else if (status === "reconciliation-pending") summary.warnings += 1;
      else summary.mergedClean += 1;
      if (status === "modified-unrecorded" || file.needsIntent) summary.needsNote += 1;
      if (file.pending) pendingCount += 1;

      files.push({
        path,
        rel,
        status,
        needsIntent: file.needsIntent,
        intents: presentIntents(manifest, file.intentIds),
        pending: buildPending(root, graft, rel, file),
      });
    }
    grafts.push({
      id: graft.id,
      name: graft.name,
      url: graft.url,
      remoteRef: graft.remoteRef,
      sourcePath: graft.path,
      dest: graft.dest,
      pinnedSha: graft.pinnedSha,
      files,
      pendingCount,
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: { name: basename(root), root },
    summary,
    grafts,
  };
}
