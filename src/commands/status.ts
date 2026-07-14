import { classifyFile, intentHashesByPath, intentHashesFor, type FileStatus } from "../core/classify";
import { ensureGitAvailable, resolveRemote } from "../core/git";
import { hashFileIfExists } from "../core/hash";
import { requireManifest } from "../core/manifest";
import { findRoot, managedFilePath, projectPath } from "../core/workspace";

export interface StatusOptions {
  cwd: string;
  /** Skip upstream checks entirely (no network); classify local state only. */
  offline?: boolean;
}

export interface StatusFile {
  path: string;
  status: FileStatus;
}

export interface StatusSource {
  url: string;
  remoteRef: string;
  path: string;
  dest: string;
  pinnedSha: string;
  /** null when running with --offline (not checked). */
  upstreamSha: string | null;
  /** null when running with --offline (unknown). */
  stale: boolean | null;
  files: StatusFile[];
}

export interface StatusResult {
  command: "status";
  exitCode: 0 | 1;
  /** True when this run skipped upstream checks. */
  offline: boolean;
  /** True when nothing is stale and every file is clean. */
  clean: boolean;
  /** True when any source's upstream ref points past its pinned SHA (always false with --offline). */
  stale: boolean;
  /** True when any tracked file differs from its stored hash (incl. intent-covered). */
  drifted: boolean;
  sources: StatusSource[];
}

const FAILING: ReadonlySet<FileStatus> = new Set(["modified-unrecorded", "missing", "conflict-unresolved"]);

export function statusCommand(opts: StatusOptions): StatusResult {
  const offline = opts.offline ?? false;
  if (!offline) ensureGitAvailable();
  const root = findRoot(opts.cwd);
  const manifest = requireManifest(root);
  const intentHashes = intentHashesByPath(manifest.intents);

  const sources: StatusSource[] = [];
  let stale = false;
  let drifted = false;
  let failing = false;

  for (const source of manifest.sources) {
    let upstreamSha: string | null = null;
    let sourceStale: boolean | null = null;
    if (!offline) {
      const head = resolveRemote(source.url, source.remoteRef);
      upstreamSha = head.sha;
      sourceStale = head.sha !== source.pinnedSha;
      if (sourceStale) stale = true;
    }

    const files: StatusFile[] = [];
    for (const [rel, storedHash] of Object.entries(source.files).sort(([a], [b]) => a.localeCompare(b))) {
      const proj = projectPath(source.dest, rel);
      const status = classifyFile({
        storedHash,
        diskHash: hashFileIfExists(managedFilePath(root, proj)),
        unresolved: source.unresolved.includes(rel),
        intentHashes: intentHashesFor(intentHashes, proj),
      });
      if (status !== "clean") drifted = true;
      if (FAILING.has(status)) failing = true;
      files.push({ path: proj, status });
    }

    sources.push({
      url: source.url,
      remoteRef: source.remoteRef,
      path: source.path,
      dest: source.dest,
      pinnedSha: source.pinnedSha,
      upstreamSha,
      stale: sourceStale,
      files,
    });
  }

  const clean = !stale && !drifted;
  const exitCode = stale || failing ? 1 : 0;
  return { command: "status", exitCode, offline, clean, stale, drifted, sources };
}
