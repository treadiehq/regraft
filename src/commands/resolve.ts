import { resolveGrafts } from "../core/grafts";
import { ensureGitAvailable } from "../core/git";
import { readFileIfExists, sha256 } from "../core/hash";
import { MutationJournal } from "../core/journal";
import { MANIFEST_FILE, requireManifest, saveManifest, type Graft } from "../core/manifest";
import { hasConflictMarkers } from "../core/merge";
import { hydratePendingTarget } from "../core/pending";
import { PATCH_MD_FILE, writePatchMd } from "../core/patchmd";
import { findRoot, managedFilePath, normalizeUserPath, projectPath, withWorkspaceLock } from "../core/workspace";
import { presentIntent, recordIntent, type IntentResult, type IntentSnapshot } from "./note";

export interface ResolveOptions {
  cwd: string;
  files?: string[];
  grafts?: string[];
  note?: string;
}

export interface ResolveResult {
  command: "resolve";
  exitCode: 0 | 1;
  resolved: string[];
  markersRemain: string[];
  needsNote: string[];
  note: IntentResult | null;
}

interface PendingEntry {
  graft: Graft;
  rel: string;
}

export function resolveCommand(opts: ResolveOptions): ResolveResult {
  const root = findRoot(opts.cwd);
  return withWorkspaceLock(root, () => {
    const journal = new MutationJournal(root);
    try {
      return resolveCommandUnlocked(opts, journal);
    } catch (error) {
      journal.rollback();
      throw error;
    }
  });
}

function resolveCommandUnlocked(opts: ResolveOptions, journal: MutationJournal): ResolveResult {
  const root = findRoot(opts.cwd);
  const manifest = requireManifest(root);
  const selected = resolveGrafts(manifest, opts.grafts);
  const pendingMap = new Map<string, PendingEntry>();
  for (const graft of selected) {
    for (const [rel, file] of Object.entries(graft.files)) {
      if (file.pending) pendingMap.set(projectPath(graft.dest, rel), { graft, rel });
    }
  }
  if ([...pendingMap.values()].some(({ graft, rel }) => graft.files[rel]?.pending?.targetKnown === false)) {
    ensureGitAvailable();
    for (const { graft, rel } of pendingMap.values()) {
      const file = graft.files[rel];
      if (file) hydratePendingTarget(root, graft, rel, file);
    }
  }

  let targets: string[];
  if (opts.files && opts.files.length > 0) {
    targets = [...new Set(opts.files.map(normalizeUserPath))];
    for (const target of targets) {
      if (!pendingMap.has(target)) {
        const listed = [...pendingMap.keys()].join(", ") || "(none)";
        throw new Error(`"${target}" has no pending judgment in the selected Grafts. Pending files: ${listed}`);
      }
    }
  } else {
    targets = [...pendingMap.keys()].sort();
  }

  if (targets.length === 0) {
    return { command: "resolve", exitCode: 0, resolved: [], markersRemain: [], needsNote: [], note: null };
  }

  const diskHashes = new Map<string, string | null>();
  const markersRemain: string[] = [];
  for (const target of targets) {
    const entry = pendingMap.get(target)!;
    const file = entry.graft.files[entry.rel]!;
    const buffer = readFileIfExists(managedFilePath(root, target));
    const hash = buffer === null ? null : sha256(buffer);
    diskHashes.set(target, hash);
    if (
      buffer !== null &&
      (file.pending?.kind === "content-conflict" || file.pending?.kind === "legacy-conflict") &&
      hasConflictMarkers(buffer)
    ) {
      markersRemain.push(target);
    }
  }
  if (markersRemain.length > 0) {
    return { command: "resolve", exitCode: 1, resolved: [], markersRemain, needsNote: [], note: null };
  }

  const snapshots: IntentSnapshot[] = [];
  const needsNote: string[] = [];
  for (const target of targets) {
    const entry = pendingMap.get(target)!;
    const file = entry.graft.files[entry.rel]!;
    const pending = file.pending!;
    const diskHash = diskHashes.get(target) ?? null;
    const retainedAdaptation = diskHash !== pending.targetHash;
    const alreadyExplained =
      retainedAdaptation &&
      !file.needsIntent &&
      file.intentIds.length > 0 &&
      diskHash === file.localHash;

    if (diskHash === null && pending.targetHash === null) {
      delete entry.graft.files[entry.rel];
      continue;
    }

    file.upstreamHash = pending.targetHash;
    file.localHash = diskHash;
    file.pending = null;
    if (!retainedAdaptation) {
      file.intentIds = [];
      file.needsIntent = false;
    } else if (opts.note?.trim()) {
      snapshots.push({ graft: entry.graft, rel: entry.rel, path: target, hash: diskHash });
    } else {
      file.needsIntent = !alreadyExplained;
      if (!alreadyExplained) needsNote.push(target);
    }
  }

  let note: IntentResult | null = null;
  if (opts.note?.trim()) {
    const describedTargets =
      snapshots.length > 0
        ? snapshots
        : targets
            .map((target) => {
              const entry = pendingMap.get(target)!;
              if (!entry.graft.files[entry.rel]) return null;
              return {
                graft: entry.graft,
                rel: entry.rel,
                path: target,
                hash: diskHashes.get(target) ?? null,
              };
            })
            .filter((snapshot): snapshot is IntentSnapshot => snapshot !== null);
    if (describedTargets.length > 0) note = presentIntent(recordIntent(manifest, opts.note, describedTargets));
  }

  journal.capture(MANIFEST_FILE);
  journal.capture(PATCH_MD_FILE);
  saveManifest(root, manifest);
  writePatchMd(root, manifest);
  return {
    command: "resolve",
    exitCode: needsNote.length > 0 ? 1 : 0,
    resolved: targets,
    markersRemain: [],
    needsNote,
    note,
  };
}
