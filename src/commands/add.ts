import {
  ensureCacheRepo,
  ensureGitAvailable,
  ensureHead,
  listFilesAt,
  pathKind,
  readFileAt,
  resolveRemote,
} from "../core/git";
import {
  assertDestinationAvailable,
  createGraftId,
  deriveGraftName,
  uniqueGraftName,
  validateGraftName,
} from "../core/grafts";
import { hashFileIfExists, sha256 } from "../core/hash";
import { MutationJournal } from "../core/journal";
import {
  MANIFEST_FILE,
  emptyManifest,
  loadManifest,
  saveManifest,
  type Graft,
  type GraftFile,
} from "../core/manifest";
import { PATCH_MD_FILE, writePatchMd } from "../core/patchmd";
import {
  getPublishedGraft,
  parsePublishedManifest,
  PUBLISHED_MANIFEST_FILE,
  type PublishedGraft,
} from "../core/published-manifest";
import { defaultDest, looksLikeSource, parseSourceArg } from "../core/urls";
import {
  cacheRoot,
  ensureWorkdir,
  findRoot,
  managedFilePath,
  normalizeUserPath,
  projectPath,
  upstreamPath,
  withWorkspaceLock,
} from "../core/workspace";

export interface AddOptions {
  cwd: string;
  force?: boolean;
  /** Track existing differing files as-is (local edits) instead of skipping them. */
  adopt?: boolean;
  dryRun?: boolean;
  /** Stable human-readable Graft name (single-source adds only). */
  name?: string;
}

export interface AddResult {
  command: "add";
  exitCode: 0 | 1;
  dryRun: boolean;
  alreadyTracked: boolean;
  source: {
    id: string;
    name: string;
    url: string;
    remoteRef: string;
    path: string;
    dest: string;
    pinnedSha: string;
    publication?: { manifestVersion: 1; name: string; description: string };
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
  if (opts.name) throw new Error("--name is only supported when adding one source.");
  const results = args.map((s) => addCommand(s, undefined, opts));
  return {
    command: "add",
    exitCode: results.some((r) => r.exitCode === 1) ? 1 : 0,
    dryRun: opts.dryRun ?? false,
    results,
  };
}

export function addCommand(sourceArg: string, destArg: string | undefined, opts: AddOptions): AddResult {
  if (opts.dryRun) return addCommandUnlocked(sourceArg, destArg, opts);
  const root = findRoot(opts.cwd);
  return withWorkspaceLock(root, () => {
    const journal = new MutationJournal(root);
    try {
      const result = addCommandUnlocked(sourceArg, destArg, opts, journal);
      if (result.exitCode === 1) {
        journal.rollback();
        result.written = [];
      }
      return result;
    } catch (error) {
      journal.rollback();
      throw error;
    }
  });
}

function addCommandUnlocked(
  sourceArg: string,
  destArg: string | undefined,
  opts: AddOptions,
  journal: MutationJournal | null = null,
): AddResult {
  ensureGitAvailable();
  if (opts.force && opts.adopt) {
    throw new Error("--force and --adopt are mutually exclusive: --force overwrites differing files, --adopt keeps them.");
  }
  const root = findRoot(opts.cwd);
  const dryRun = opts.dryRun ?? false;
  const manifest = loadManifest(root) ?? emptyManifest();
  const request = parseSourceArg(sourceArg);
  const requestedDest = destArg === undefined ? undefined : normalizeUserPath(destArg);
  const cache = ensureCacheRepo(cacheRoot(root), request.url);

  let head: ReturnType<typeof resolveRemote>;
  let sha: string;
  let sourcePath = request.path;
  let published: { name: string; graft: PublishedGraft } | null = null;

  const resolvePublished = (name: string): void => {
    head = resolveRemote(request.url);
    sha = ensureHead(cache, request.url, head);
    let text: string;
    try {
      text = readFileAt(cache, sha, PUBLISHED_MANIFEST_FILE).toString("utf8");
    } catch {
      throw new Error(
        `${request.url} does not publish ${PUBLISHED_MANIFEST_FILE} at ${head.ref}. ` +
          `Use a direct source path or ask the maintainer to publish Grafts.`,
      );
    }
    const publishedManifest = parsePublishedManifest(text, `${request.url}@${sha.slice(0, 7)}:${PUBLISHED_MANIFEST_FILE}`);
    const graft = getPublishedGraft(publishedManifest, name);
    sourcePath = graft.path;
    published = { name, graft };
  };

  if (request.graft) {
    resolvePublished(request.graft);
  } else if (request.graftCandidate) {
    try {
      head = resolveRemote(request.url, request.ref);
      sha = ensureHead(cache, request.url, head);
    } catch (refError) {
      try {
        resolvePublished(request.graftCandidate);
      } catch (graftError) {
        throw new Error(
          `"${request.graftCandidate}" is neither a reachable ref nor a published Graft on ${request.url}.\n` +
            `Ref lookup: ${(refError as Error).message}\nGraft lookup: ${(graftError as Error).message}`,
        );
      }
    }
  } else {
    head = resolveRemote(request.url, request.ref);
    sha = ensureHead(cache, request.url, head);
  }

  const publication = published as { name: string; graft: PublishedGraft } | null;
  const resolvedSpec = {
    url: request.url,
    ref: head!.ref,
    path: sourcePath,
    ...(publication ? { graft: publication.name } : {}),
  };
  const dest = requestedDest ?? normalizeUserPath(defaultDest(resolvedSpec));
  if (!dest) throw new Error("dest must not be empty.");

  const existing = manifest.grafts.find(
    (graft) =>
      graft.url === request.url &&
      graft.remoteRef === head!.ref &&
      graft.path === sourcePath &&
      graft.dest === dest,
  );
  if (existing) {
    return {
      command: "add",
      exitCode: 0,
      dryRun,
      alreadyTracked: true,
      source: {
        id: existing.id,
        name: existing.name,
        url: existing.url,
        remoteRef: existing.remoteRef,
        path: existing.path,
        dest: existing.dest,
        pinnedSha: existing.pinnedSha,
        ...(existing.publication ? { publication: existing.publication } : {}),
      },
      written: [],
      identical: [],
      adopted: [],
      skipped: [],
    };
  }

  assertDestinationAvailable(manifest.grafts, dest);
  const explicitName = opts.name?.trim();
  if (explicitName) {
    validateGraftName(explicitName);
    if (manifest.grafts.some((graft) => graft.name === explicitName)) {
      throw new Error(`A Graft named "${explicitName}" already exists. Choose another --name.`);
    }
  }
  const baseName = explicitName ?? publication?.name ?? deriveGraftName(dest);
  const name = explicitName
    ? explicitName
    : uniqueGraftName(baseName, new Set(manifest.grafts.map((graft) => graft.name)));
  const id = createGraftId({ url: request.url, remoteRef: head!.ref, path: sourcePath, dest });

  const kind = pathKind(cache, sha!, sourcePath);
  if (kind === "missing") {
    throw new Error(`Path "${sourcePath}" does not exist in ${request.url} at ${head!.ref} (${sha!.slice(0, 7)}).`);
  }

  const rels = listFilesAt(cache, sha!, sourcePath);
  const files: Record<string, GraftFile> = {};
  const written: string[] = [];
  const identical: string[] = [];
  const adopted: string[] = [];
  const skipped: { path: string; reason: string }[] = [];

  for (const rel of rels) {
    const buf = readFileAt(cache, sha!, upstreamPath(sourcePath, rel));
    const upHash = sha256(buf);
    const proj = projectPath(dest, rel);
    const abs = managedFilePath(root, proj);
    const diskHash = hashFileIfExists(abs);
    if (diskHash === null) {
      if (!dryRun) journal!.write(proj, buf);
      files[rel] = fileState(upHash, upHash);
      written.push(proj);
    } else if (diskHash === upHash) {
      files[rel] = fileState(upHash, upHash);
      identical.push(proj);
    } else if (opts.adopt) {
      files[rel] = fileState(upHash, diskHash, true);
      adopted.push(proj);
    } else if (opts.force) {
      if (!dryRun) journal!.write(proj, buf);
      files[rel] = fileState(upHash, upHash);
      written.push(proj);
    } else {
      skipped.push({ path: proj, reason: "exists with different content (re-run with --force to overwrite, or --adopt to keep it)" });
    }
  }

  const source: Graft = {
    id,
    name,
    url: request.url,
    remoteRef: head!.ref,
    path: sourcePath,
    dest,
    pinnedSha: sha!,
    ownership: "complete",
    excluded: [],
    files,
    ...(publication
      ? {
          publication: {
            manifestVersion: 1 as const,
            name: publication.name,
            description: publication.graft.description,
          },
        }
      : {}),
  };

  if (!dryRun && skipped.length === 0) {
    manifest.grafts.push(source);
    journal!.capture(MANIFEST_FILE);
    journal!.capture(PATCH_MD_FILE);
    saveManifest(root, manifest);
    writePatchMd(root, manifest);
    ensureWorkdir(root);
  } else if (!dryRun) {
    ensureWorkdir(root);
  }

  return {
    command: "add",
    exitCode: skipped.length > 0 ? 1 : 0,
    dryRun,
    alreadyTracked: false,
    source: {
      id: source.id,
      name: source.name,
      url: source.url,
      remoteRef: source.remoteRef,
      path: source.path,
      dest: source.dest,
      pinnedSha: sha!,
      ...(source.publication ? { publication: source.publication } : {}),
    },
    written,
    identical,
    adopted,
    skipped,
  };
}

function fileState(upstreamHash: string, localHash: string, needsIntent = false): GraftFile {
  return {
    upstreamHash,
    localHash,
    intentIds: [],
    needsIntent,
    pending: null,
  };
}
