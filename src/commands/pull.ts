import { briefTimestamp, renderBrief, writeBrief, type BriefSection, type BriefWarning } from "../core/brief";
import { findUnrecordedModifications } from "../core/classify";
import {
  ensureCacheRepo,
  ensureCommit,
  ensureGitAvailable,
  ensureHead,
  listFilesAt,
  logRange,
  readFileAt,
  resolveRemote,
} from "../core/git";
import { resolveGrafts } from "../core/grafts";
import { isBinary, readFileIfExists, sha256 } from "../core/hash";
import { MutationJournal } from "../core/journal";
import {
  MANIFEST_FILE,
  requireManifest,
  saveManifest,
  type Graft,
  type GraftFile,
  type PendingKind,
  type PendingReconciliation,
} from "../core/manifest";
import { mergeThreeWay } from "../core/merge";
import { hydratePendingTarget } from "../core/pending";
import { PATCH_MD_FILE, writePatchMd } from "../core/patchmd";
import {
  cacheRoot,
  findRoot,
  managedFilePath,
  projectPath,
  upstreamPath,
  withWorkspaceLock,
  WORKDIR_NAME,
} from "../core/workspace";

export interface PullOptions {
  cwd: string;
  grafts?: string[];
  dryRun?: boolean;
  force?: boolean;
}

export interface PullSourceResult {
  id: string;
  name: string;
  url: string;
  remoteRef: string;
  path: string;
  dest: string;
  oldSha: string;
  newSha: string;
  upToDate: boolean;
  added: string[];
  fastForwarded: string[];
  merged: string[];
  forced: string[];
  deleted: string[];
  conflicts: string[];
  skipped: { path: string; reason: string }[];
  warnings: { path: string; message: string }[];
}

export interface PullResult {
  command: "pull";
  exitCode: 0 | 1;
  dryRun: boolean;
  conflicts: boolean;
  brief: string | null;
  unrecordedModifications: string[];
  sources: PullSourceResult[];
}

interface PullContext {
  dryRun: boolean;
  force: boolean;
  journal: MutationJournal | null;
}

function emptyResult(graft: Graft, oldSha = graft.pinnedSha, newSha = graft.pinnedSha): PullSourceResult {
  return {
    id: graft.id,
    name: graft.name,
    url: graft.url,
    remoteRef: graft.remoteRef,
    path: graft.path,
    dest: graft.dest,
    oldSha,
    newSha,
    upToDate: false,
    added: [],
    fastForwarded: [],
    merged: [],
    forced: [],
    deleted: [],
    conflicts: [],
    skipped: [],
    warnings: [],
  };
}

function pendingMessage(kind: PendingKind): string {
  switch (kind) {
    case "binary-conflict":
      return "binary file changed both locally and upstream; choose local or take upstream with --force";
    case "upstream-deleted":
      return "upstream deleted this locally adapted file; keep it with resolve or delete it with --force";
    case "local-deleted":
      return "file was deleted locally while upstream changed it; restore/keep the deletion with resolve or take upstream with --force";
    case "destination-collision":
      return "new upstream file collides with local content; move/accept it with resolve or overwrite with --force";
    case "ownership-unknown":
      return "legacy manifest cannot prove whether this upstream file was originally owned; review it explicitly";
    case "legacy-conflict":
      return "legacy unresolved conflict requires judgment";
    case "content-conflict":
      return "text conflict requires judgment";
  }
}

function createPending(
  kind: PendingKind,
  fromSha: string,
  toSha: string,
  targetHash: string | null,
  observedLocalHash: string | null,
  markerHash: string | null = null,
): PendingReconciliation {
  return {
    kind,
    fromSha,
    toSha,
    targetKnown: true,
    targetHash,
    observedLocalHash,
    markerHash,
    brief: null,
  };
}

function freshFile(upstreamHash: string | null, localHash: string | null): GraftFile {
  return {
    upstreamHash,
    localHash,
    intentIds: [],
    needsIntent: false,
    pending: null,
  };
}

function pendingEntries(graft: Graft): [string, GraftFile][] {
  return Object.entries(graft.files).filter((entry): entry is [string, GraftFile] => entry[1].pending !== null);
}

export function pullCommand(opts: PullOptions): PullResult {
  if (opts.dryRun) return pullCommandUnlocked(opts);
  const root = findRoot(opts.cwd);
  return withWorkspaceLock(root, () => {
    const journal = new MutationJournal(root);
    try {
      return pullCommandUnlocked(opts, journal);
    } catch (error) {
      journal.rollback();
      throw error;
    }
  });
}

function pullCommandUnlocked(opts: PullOptions, journal: MutationJournal | null = null): PullResult {
  ensureGitAvailable();
  const root = findRoot(opts.cwd);
  const manifest = requireManifest(root);
  const selected = resolveGrafts(manifest, opts.grafts);
  const context: PullContext = {
    dryRun: opts.dryRun ?? false,
    force: opts.force ?? false,
    journal,
  };
  const unrecordedModifications = findUnrecordedModifications(root, manifest, selected);
  const sources: PullSourceResult[] = [];
  const briefSections: BriefSection[] = [];
  let briefPath: string | null = null;

  for (const graft of selected) {
    const pending = pendingEntries(graft);
    if (pending.length > 0) {
      briefPath ??= pending.map(([, file]) => file.pending?.brief ?? null).find((path) => path !== null) ?? null;
      sources.push(reconcilePending(root, graft, context));
      continue;
    }

    const head = resolveRemote(graft.url, graft.remoteRef);
    if (head.sha === graft.pinnedSha) {
      const result = emptyResult(graft);
      result.upToDate = true;
      sources.push(result);
      continue;
    }

    const cache = ensureCacheRepo(cacheRoot(root), graft.url);
    const newSha = ensureHead(cache, graft.url, head);
    ensureCommit(cache, graft.url, graft.pinnedSha, graft.remoteRef);
    const oldSha = graft.pinnedSha;
    const result = pullGraft(root, cache, graft, newSha, context);
    sources.push(result);

    if (result.conflicts.length > 0 || result.warnings.length > 0) {
      const affectedPaths = new Set([
        ...result.conflicts,
        ...result.warnings.map((warning) => warning.path),
      ]);
      briefSections.push({
        graftId: graft.id,
        graftName: graft.name,
        url: graft.url,
        remoteRef: graft.remoteRef,
        oldSha,
        newSha,
        conflicts: result.conflicts,
        warnings: result.warnings as BriefWarning[],
        activeIntentIds: [
          ...new Set(
            Object.entries(graft.files)
              .filter(([rel]) => affectedPaths.has(projectPath(graft.dest, rel)))
              .flatMap(([, file]) => file.intentIds),
          ),
        ],
        log: logRange(cache, oldSha, newSha, graft.path),
      });
    }
    if (!context.dryRun) graft.pinnedSha = newSha;
  }

  if (briefSections.length > 0 && !context.dryRun) {
    const now = new Date();
    context.journal?.capture(`${WORKDIR_NAME}/briefs/${briefTimestamp(now)}.md`);
    briefPath = writeBrief(root, renderBrief(briefSections, manifest.intents, now), now);
    const affected = new Set(
      briefSections.flatMap((section) => [...section.conflicts, ...section.warnings.map((warning) => warning.path)]),
    );
    for (const graft of selected) {
      for (const [rel, file] of Object.entries(graft.files)) {
        if (file.pending && affected.has(projectPath(graft.dest, rel))) file.pending.brief = briefPath;
      }
    }
  }

  if (!context.dryRun) {
    context.journal?.capture(MANIFEST_FILE);
    context.journal?.capture(PATCH_MD_FILE);
    saveManifest(root, manifest);
    writePatchMd(root, manifest);
  }

  const conflicts = sources.some((source) => source.conflicts.length > 0);
  const warnings = sources.some((source) => source.warnings.length > 0);
  return {
    command: "pull",
    exitCode: conflicts || warnings ? 1 : 0,
    dryRun: context.dryRun,
    conflicts,
    brief: briefPath,
    unrecordedModifications,
    sources,
  };
}

function reconcilePending(root: string, graft: Graft, context: PullContext): PullSourceResult {
  const entries = pendingEntries(graft);
  const oldest = entries[0]?.[1].pending?.fromSha ?? graft.pinnedSha;
  const result = emptyResult(graft, oldest ?? graft.pinnedSha, graft.pinnedSha);

  if (!context.force) {
    for (const [rel, file] of entries) {
      const pending = file.pending!;
      const path = projectPath(graft.dest, rel);
      if (pending.kind === "content-conflict" || pending.kind === "legacy-conflict") {
        result.conflicts.push(path);
      } else {
        result.warnings.push({ path, message: pendingMessage(pending.kind) });
      }
      result.skipped.push({ path, reason: "pending judgment; run `regraft resolve` or `regraft pull --force`" });
    }
    return result;
  }

  const cache = ensureCacheRepo(cacheRoot(root), graft.url);
  for (const [rel, file] of entries) {
    hydratePendingTarget(root, graft, rel, file);
    const pending = file.pending!;
    ensureCommit(cache, graft.url, pending.toSha, graft.remoteRef);
    const path = projectPath(graft.dest, rel);
    if (pending.targetHash === null) {
      if (!context.dryRun) {
        context.journal!.remove(path);
        delete graft.files[rel];
      }
      result.deleted.push(path);
      continue;
    }
    const target = readFileAt(cache, pending.toSha, upstreamPath(graft.path, rel));
    if (!context.dryRun) {
      context.journal!.write(path, target);
      file.upstreamHash = pending.targetHash;
      file.localHash = pending.targetHash;
      file.intentIds = [];
      file.needsIntent = false;
      file.pending = null;
    }
    result.forced.push(path);
  }
  return result;
}

function pullGraft(
  root: string,
  cache: string,
  graft: Graft,
  newSha: string,
  context: PullContext,
): PullSourceResult {
  const oldSha = graft.pinnedSha;
  const oldSet = new Set(listFilesAt(cache, oldSha, graft.path));
  const newSet = new Set(listFilesAt(cache, newSha, graft.path));
  const rels = [...new Set([...Object.keys(graft.files), ...oldSet, ...newSet])].sort();
  const result = emptyResult(graft, oldSha, newSha);

  for (const rel of rels) {
    const path = projectPath(graft.dest, rel);
    if (graft.excluded.includes(rel)) {
      result.skipped.push({
        path,
        reason: "explicitly excluded because it was not owned when the Graft was created",
      });
      continue;
    }
    const absolute = managedFilePath(root, path);
    const disk = readFileIfExists(absolute);
    const diskHash = disk === null ? null : sha256(disk);
    const oldBuffer = oldSet.has(rel) ? readFileAt(cache, oldSha, upstreamPath(graft.path, rel)) : null;
    const oldHash = oldBuffer === null ? null : sha256(oldBuffer);
    const newBuffer = newSet.has(rel) ? readFileAt(cache, newSha, upstreamPath(graft.path, rel)) : null;
    const newHash = newBuffer === null ? null : sha256(newBuffer);
    const trackedFile = graft.files[rel];
    if (!trackedFile && oldHash !== null) {
      if (!context.dryRun) {
        graft.excluded.push(rel);
        graft.excluded.sort();
      }
      result.skipped.push({
        path,
        reason: "not tracked because it was skipped when the Graft was created",
      });
      continue;
    }
    let file = trackedFile ?? freshFile(oldHash, oldHash);

    if (oldHash === newHash) {
      if (!context.dryRun) {
        file.upstreamHash = oldHash;
        if (!graft.files[rel]) graft.files[rel] = file;
      }
      continue;
    }

    if (oldHash === null && newBuffer !== null && newHash !== null) {
      if (!trackedFile && graft.ownership === "legacy-unknown" && !context.force) {
        file = freshFile(null, diskHash);
        file.needsIntent = diskHash !== null;
        file.pending = createPending("ownership-unknown", oldSha, newSha, newHash, diskHash);
        if (!context.dryRun) graft.files[rel] = file;
        result.skipped.push({
          path,
          reason: "legacy manifest cannot prove whether this Source file was previously excluded",
        });
        result.warnings.push({ path, message: pendingMessage("ownership-unknown") });
      } else if (trackedFile && diskHash !== newHash && !context.force) {
        file.upstreamHash = null;
        if (diskHash !== file.localHash) file.needsIntent = true;
        const kind: PendingKind = diskHash === null ? "local-deleted" : "destination-collision";
        file.pending = createPending(kind, oldSha, newSha, newHash, diskHash);
        if (!context.dryRun) graft.files[rel] = file;
        result.skipped.push({
          path,
          reason:
            diskHash === null
              ? "upstream reintroduced a file that is intentionally absent locally"
              : "upstream reintroduced a file that is intentionally retained locally",
        });
        result.warnings.push({ path, message: pendingMessage(kind) });
      } else if (diskHash === null) {
        if (!context.dryRun) {
          context.journal!.write(path, newBuffer);
          graft.files[rel] = freshFile(newHash, newHash);
        }
        result.added.push(path);
      } else if (diskHash === newHash) {
        if (!context.dryRun) graft.files[rel] = freshFile(newHash, newHash);
        result.added.push(path);
      } else if (context.force) {
        if (!context.dryRun) {
          context.journal!.write(path, newBuffer);
          graft.files[rel] = freshFile(newHash, newHash);
        }
        result.forced.push(path);
      } else {
        file = freshFile(null, diskHash);
        file.needsIntent = true;
        file.pending = createPending("destination-collision", oldSha, newSha, newHash, diskHash);
        if (!context.dryRun) graft.files[rel] = file;
        result.skipped.push({ path, reason: "new upstream file collides with existing local content" });
        result.warnings.push({ path, message: pendingMessage("destination-collision") });
      }
      continue;
    }

    if (newBuffer === null || newHash === null) {
      if (diskHash === null) {
        if (!context.dryRun) delete graft.files[rel];
        result.deleted.push(path);
      } else if (diskHash === oldHash || context.force) {
        if (!context.dryRun) {
          context.journal!.remove(path);
          delete graft.files[rel];
        }
        result.deleted.push(path);
      } else {
        file.upstreamHash = oldHash;
        if (diskHash !== file.localHash) file.needsIntent = true;
        file.pending = createPending("upstream-deleted", oldSha, newSha, null, diskHash);
        if (!context.dryRun) graft.files[rel] = file;
        result.warnings.push({ path, message: pendingMessage("upstream-deleted") });
      }
      continue;
    }

    if (diskHash === null) {
      if (context.force) {
        if (!context.dryRun) {
          context.journal!.write(path, newBuffer);
          graft.files[rel] = freshFile(newHash, newHash);
        }
        result.forced.push(path);
      } else {
        file.upstreamHash = oldHash;
        file.pending = createPending("local-deleted", oldSha, newSha, newHash, null);
        if (!context.dryRun) graft.files[rel] = file;
        result.warnings.push({ path, message: pendingMessage("local-deleted") });
      }
      continue;
    }

    if (diskHash === oldHash) {
      if (!context.dryRun) {
        context.journal!.write(path, newBuffer);
        graft.files[rel] = freshFile(newHash, newHash);
      }
      result.fastForwarded.push(path);
      continue;
    }

    if (diskHash === newHash) {
      if (!context.dryRun) graft.files[rel] = freshFile(newHash, newHash);
      result.fastForwarded.push(path);
      continue;
    }

    const localBuffer = disk as Buffer;
    const targetBuffer = newBuffer as Buffer;
    const binary = isBinary(localBuffer) || isBinary(targetBuffer) || (oldBuffer !== null && isBinary(oldBuffer));
    if (binary) {
      if (context.force) {
        if (!context.dryRun) {
          context.journal!.write(path, targetBuffer);
          graft.files[rel] = freshFile(newHash, newHash);
        }
        result.forced.push(path);
      } else {
        file.upstreamHash = oldHash;
        if (diskHash !== file.localHash) file.needsIntent = true;
        file.pending = createPending("binary-conflict", oldSha, newSha, newHash, diskHash);
        if (!context.dryRun) graft.files[rel] = file;
        result.warnings.push({ path, message: pendingMessage("binary-conflict") });
      }
      continue;
    }

    const merged = mergeThreeWay({ base: oldBuffer ?? Buffer.alloc(0), ours: localBuffer, theirs: targetBuffer });
    if (!merged.conflicted) {
      const mergedHash = sha256(merged.content);
      const needsIntent = file.needsIntent || file.intentIds.length === 0 || diskHash !== file.localHash;
      if (!context.dryRun) {
        context.journal!.write(path, merged.content);
        file.upstreamHash = newHash;
        file.localHash = mergedHash;
        file.needsIntent = needsIntent;
        file.pending = null;
        graft.files[rel] = file;
      }
      result.merged.push(path);
    } else if (context.force) {
      if (!context.dryRun) {
        context.journal!.write(path, targetBuffer);
        graft.files[rel] = freshFile(newHash, newHash);
      }
      result.forced.push(path);
    } else {
      const markerHash = sha256(merged.content);
      file.upstreamHash = oldHash;
      if (diskHash !== file.localHash) file.needsIntent = true;
      file.pending = createPending("content-conflict", oldSha, newSha, newHash, diskHash, markerHash);
      if (!context.dryRun) {
        context.journal!.write(path, merged.content);
        graft.files[rel] = file;
      }
      result.conflicts.push(path);
    }
  }

  return result;
}
