import {
  ensureCacheRepo,
  ensureGitAvailable,
  ensureHead,
  listFilesAt,
  pathKind,
  readFileAt,
  resolveRemote,
} from "../core/git";
import { hashFileIfExists, sha256 } from "../core/hash";
import { emptyManifest, loadManifest, saveManifest, type Source } from "../core/manifest";
import { writePatchMd } from "../core/patchmd";
import { defaultDest, looksLikeSource, parseSourceArg } from "../core/urls";
import {
  cacheRoot,
  ensureWorkdir,
  findRoot,
  managedFilePath,
  normalizeUserPath,
  projectPath,
  upstreamPath,
  writeFileEnsuringDir,
} from "../core/workspace";

export interface AddOptions {
  cwd: string;
  force?: boolean;
  /** Track existing differing files as-is (local edits) instead of skipping them. */
  adopt?: boolean;
  dryRun?: boolean;
}

export interface AddResult {
  command: "add";
  exitCode: 0 | 1;
  dryRun: boolean;
  alreadyTracked: boolean;
  source: {
    url: string;
    remoteRef: string;
    path: string;
    dest: string;
    pinnedSha: string;
  };
  written: string[];
  identical: string[];
  /** Existing differing files tracked as local modifications (--adopt). */
  adopted: string[];
  skipped: { path: string; reason: string }[];
}

export interface AddManyResult {
  command: "add";
  exitCode: 0 | 1;
  dryRun: boolean;
  results: AddResult[];
}

/**
 * CLI entry for `add` with one or more positional args.
 *
 * The last argument is a destination only when it is not recognizable as a
 * source (no scheme, no #ref, no /tree|blob|pull/ segment). A destination is
 * only allowed with a single source.
 */
export function addCliCommand(args: string[], opts: AddOptions): AddResult | AddManyResult {
  const last = args[args.length - 1];
  if (args.length === 1 || last === undefined) {
    return addCommand(args[0] as string, undefined, opts);
  }
  if (!looksLikeSource(last)) {
    if (args.length === 2) return addCommand(args[0] as string, last, opts);
    throw new Error(
      `"${last}" looks like a destination, but a destination is only supported with a single source.\n` +
        `Add sources one at a time to control where each one goes.`,
    );
  }
  const results = args.map((s) => addCommand(s, undefined, opts));
  return {
    command: "add",
    exitCode: results.some((r) => r.exitCode === 1) ? 1 : 0,
    dryRun: opts.dryRun ?? false,
    results,
  };
}

export function addCommand(sourceArg: string, destArg: string | undefined, opts: AddOptions): AddResult {
  ensureGitAvailable();
  if (opts.force && opts.adopt) {
    throw new Error("--force and --adopt are mutually exclusive: --force overwrites differing files, --adopt keeps them.");
  }
  const root = findRoot(opts.cwd);
  const dryRun = opts.dryRun ?? false;
  const manifest = loadManifest(root) ?? emptyManifest();
  const spec = parseSourceArg(sourceArg);
  const dest = normalizeUserPath(destArg ?? defaultDest(spec));
  if (!dest) throw new Error("dest must not be empty.");

  const existing = manifest.sources.find((s) => s.url === spec.url && s.path === spec.path);
  if (existing) {
    return {
      command: "add",
      exitCode: 0,
      dryRun,
      alreadyTracked: true,
      source: {
        url: existing.url,
        remoteRef: existing.remoteRef,
        path: existing.path,
        dest: existing.dest,
        pinnedSha: existing.pinnedSha,
      },
      written: [],
      identical: [],
      adopted: [],
      skipped: [],
    };
  }

  const head = resolveRemote(spec.url, spec.ref);
  const cache = ensureCacheRepo(cacheRoot(root), spec.url);
  const sha = ensureHead(cache, spec.url, head);

  const kind = pathKind(cache, sha, spec.path);
  if (kind === "missing") {
    throw new Error(`Path "${spec.path}" does not exist in ${spec.url} at ${head.ref} (${sha.slice(0, 7)}).`);
  }

  const rels = listFilesAt(cache, sha, spec.path);
  const files: Record<string, string> = {};
  const written: string[] = [];
  const identical: string[] = [];
  const adopted: string[] = [];
  const skipped: { path: string; reason: string }[] = [];

  for (const rel of rels) {
    const buf = readFileAt(cache, sha, upstreamPath(spec.path, rel));
    const upHash = sha256(buf);
    const proj = projectPath(dest, rel);
    const abs = managedFilePath(root, proj);
    const diskHash = hashFileIfExists(abs);
    if (diskHash === null) {
      if (!dryRun) writeFileEnsuringDir(root, proj, buf);
      files[rel] = upHash;
      written.push(proj);
    } else if (diskHash === upHash) {
      files[rel] = upHash;
      identical.push(proj);
    } else if (opts.adopt) {
      // Track upstream's content as the baseline and leave disk alone: the
      // existing local version immediately classifies as a modification.
      files[rel] = upHash;
      adopted.push(proj);
    } else if (opts.force) {
      if (!dryRun) writeFileEnsuringDir(root, proj, buf);
      files[rel] = upHash;
      written.push(proj);
    } else {
      skipped.push({ path: proj, reason: "exists with different content (re-run with --force to overwrite, or --adopt to keep it)" });
    }
  }

  const source: Source = {
    url: spec.url,
    remoteRef: head.ref,
    path: spec.path,
    dest,
    pinnedSha: sha,
    files,
    unresolved: [],
  };

  if (!dryRun) {
    manifest.sources.push(source);
    saveManifest(root, manifest);
    writePatchMd(root, manifest);
    ensureWorkdir(root);
  }

  return {
    command: "add",
    exitCode: skipped.length > 0 ? 1 : 0,
    dryRun,
    alreadyTracked: false,
    source: { url: source.url, remoteRef: source.remoteRef, path: source.path, dest: source.dest, pinnedSha: sha },
    written,
    identical,
    adopted,
    skipped,
  };
}
