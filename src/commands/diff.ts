import { unifiedDiff } from "../core/diff";
import {
  ensureCacheRepo,
  ensureCommit,
  ensureGitAvailable,
  ensureHead,
  listFilesAt,
  readFileAt,
  resolveRemote,
} from "../core/git";
import { isBinary, readFileIfExists, sha256 } from "../core/hash";
import { requireManifest, type Source } from "../core/manifest";
import { cacheRoot, findRoot, managedFilePath, normalizeUserPath, projectPath, upstreamPath } from "../core/workspace";

export interface DiffOptions {
  cwd: string;
  /** Project-relative files to scope the diff to (default: everything). */
  files?: string[];
  /** Show what changed upstream since the pinned SHA instead of local drift. */
  upstream?: boolean;
}

export interface DiffFileEntry {
  path: string;
  change: "modified" | "missing" | "added" | "deleted";
  binary: boolean;
  /** Unified diff text ("" when binary, missing, or no baseline). */
  diff: string;
  note: string | null;
}

export interface DiffSourceResult {
  url: string;
  remoteRef: string;
  path: string;
  dest: string;
  pinnedSha: string;
  /** Resolved upstream SHA (upstream mode only; null in local mode). */
  upstreamSha: string | null;
  files: DiffFileEntry[];
}

export interface DiffResult {
  command: "diff";
  exitCode: 0 | 1;
  /** True when run with --upstream. */
  upstream: boolean;
  sources: DiffSourceResult[];
}

export function diffCommand(opts: DiffOptions): DiffResult {
  ensureGitAvailable();
  const root = findRoot(opts.cwd);
  const manifest = requireManifest(root);

  let filter: Set<string> | null = null;
  if (opts.files && opts.files.length > 0) {
    filter = new Set(opts.files.map(normalizeUserPath));
    const tracked = new Set(
      manifest.sources.flatMap((s) => Object.keys(s.files).map((rel) => projectPath(s.dest, rel))),
    );
    for (const f of filter) {
      if (!tracked.has(f)) {
        const dests = manifest.sources.map((s) => s.dest).join(", ") || "(none)";
        throw new Error(`"${f}" is not a tracked file. Tracked files live under: ${dests}`);
      }
    }
  }

  const sources: DiffSourceResult[] = [];
  for (const source of manifest.sources) {
    sources.push(opts.upstream ? diffUpstream(root, source, filter) : diffLocal(root, source, filter));
  }

  const anyChange = sources.some((s) => s.files.length > 0);
  return { command: "diff", exitCode: anyChange ? 1 : 0, upstream: opts.upstream ?? false, sources };
}

/** Local drift: disk content vs the baseline regraft last wrote. */
function diffLocal(root: string, source: Source, filter: Set<string> | null): DiffSourceResult {
  const result: DiffSourceResult = {
    url: source.url,
    remoteRef: source.remoteRef,
    path: source.path,
    dest: source.dest,
    pinnedSha: source.pinnedSha,
    upstreamSha: null,
    files: [],
  };

  let cache: string | null = null;
  const rels = Object.keys(source.files).sort();
  for (const rel of rels) {
    const proj = projectPath(source.dest, rel);
    if (filter && !filter.has(proj)) continue;
    const stored = source.files[rel] as string;
    const diskBuf = readFileIfExists(managedFilePath(root, proj));
    if (diskBuf === null) {
      result.files.push({ path: proj, change: "missing", binary: false, diff: "", note: "file is missing from disk" });
      continue;
    }
    if (sha256(diskBuf) === stored) continue;

    if (cache === null) {
      cache = ensureCacheRepo(cacheRoot(root), source.url);
      ensureCommit(cache, source.url, source.pinnedSha, source.remoteRef);
    }
    let baseBuf: Buffer | null;
    try {
      baseBuf = readFileAt(cache, source.pinnedSha, upstreamPath(source.path, rel));
    } catch {
      baseBuf = null;
    }

    const unresolvedNote = source.unresolved.includes(rel)
      ? "has unresolved conflict markers from a pull"
      : null;

    if (baseBuf === null) {
      const binary = isBinary(diskBuf);
      result.files.push({
        path: proj,
        change: "modified",
        binary,
        diff: "",
        note: joinNotes(
          "not present upstream at the pinned commit; no baseline to diff against",
          binary ? "binary file; no text diff" : null,
          unresolvedNote,
        ),
      });
      continue;
    }
    if (isBinary(diskBuf) || isBinary(baseBuf)) {
      result.files.push({ path: proj, change: "modified", binary: true, diff: "", note: joinNotes("binary file; no text diff", unresolvedNote) });
      continue;
    }
    const baselineNote =
      sha256(baseBuf) === stored
        ? null
        : "baseline is the pinned upstream content; this diff includes earlier fixed local changes";
    result.files.push({
      path: proj,
      change: "modified",
      binary: false,
      diff: unifiedDiff(proj, baseBuf, diskBuf),
      note: joinNotes(baselineNote, unresolvedNote),
    });
  }
  return result;
}

/** Upstream movement: content at the pinned SHA vs the current remote head. */
function diffUpstream(root: string, source: Source, filter: Set<string> | null): DiffSourceResult {
  const head = resolveRemote(source.url, source.remoteRef);
  const cache = ensureCacheRepo(cacheRoot(root), source.url);
  const newSha = ensureHead(cache, source.url, head);

  const result: DiffSourceResult = {
    url: source.url,
    remoteRef: source.remoteRef,
    path: source.path,
    dest: source.dest,
    pinnedSha: source.pinnedSha,
    upstreamSha: newSha,
    files: [],
  };
  if (newSha === source.pinnedSha) return result;

  ensureCommit(cache, source.url, source.pinnedSha, source.remoteRef);
  const oldSet = new Set(listFilesAt(cache, source.pinnedSha, source.path));
  const newSet = new Set(listFilesAt(cache, newSha, source.path));
  const rels = [...new Set([...oldSet, ...newSet])].sort();

  for (const rel of rels) {
    const proj = projectPath(source.dest, rel);
    if (filter && !filter.has(proj)) continue;
    const oldBuf = oldSet.has(rel) ? readFileAt(cache, source.pinnedSha, upstreamPath(source.path, rel)) : null;
    const newBuf = newSet.has(rel) ? readFileAt(cache, newSha, upstreamPath(source.path, rel)) : null;
    if (oldBuf !== null && newBuf !== null && sha256(oldBuf) === sha256(newBuf)) continue;

    const change = oldBuf === null ? "added" : newBuf === null ? "deleted" : "modified";
    if ((oldBuf !== null && isBinary(oldBuf)) || (newBuf !== null && isBinary(newBuf))) {
      result.files.push({ path: proj, change, binary: true, diff: "", note: "binary file; no text diff" });
      continue;
    }
    result.files.push({
      path: proj,
      change,
      binary: false,
      diff: unifiedDiff(proj, oldBuf ?? Buffer.alloc(0), newBuf ?? Buffer.alloc(0)),
      note: null,
    });
  }
  return result;
}

function joinNotes(...notes: (string | null)[]): string | null {
  const present = notes.filter((n): n is string => n !== null);
  return present.length > 0 ? present.join("; ") : null;
}
