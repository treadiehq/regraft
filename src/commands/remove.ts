import { existsSync } from "node:fs";
import { MutationJournal } from "../core/journal";
import { MANIFEST_FILE, requireManifest, saveManifest } from "../core/manifest";
import { PATCH_MD_FILE, writePatchMd } from "../core/patchmd";
import {
  findRoot,
  managedFilePath,
  normalizeUserPath,
  projectPath,
  withWorkspaceLock,
} from "../core/workspace";

export interface RemoveOptions {
  cwd: string;
  hard?: boolean;
}

export interface RemoveResult {
  command: "remove";
  exitCode: 0;
  hard: boolean;
  removed: {
    id: string;
    name: string;
    url: string;
    remoteRef: string;
    path: string;
    dest: string;
  };
  /** Files deleted from disk (only with --hard). */
  deletedFiles: string[];
}

export function removeCommand(query: string, opts: RemoveOptions): RemoveResult {
  const root = findRoot(opts.cwd);
  return withWorkspaceLock(root, () => {
    const journal = new MutationJournal(root);
    try {
      return removeCommandUnlocked(query, opts, journal);
    } catch (error) {
      journal.rollback();
      throw error;
    }
  });
}

function removeCommandUnlocked(query: string, opts: RemoveOptions, journal: MutationJournal): RemoveResult {
  const root = findRoot(opts.cwd);
  const manifest = requireManifest(root);

  const describe = (s: { url: string; path: string; dest: string }): string =>
    `  ${s.url}${s.path ? `#${s.path}` : ""} → ${s.dest}`;

  const destQuery = normalizeUserPath(query);
  const exact = manifest.grafts.find((graft) => graft.id === query || graft.name === query);
  const matches = exact
    ? [exact]
    : manifest.grafts.filter(
        (graft) => graft.url.includes(query) || (destQuery !== "" && graft.dest.includes(destQuery)),
      );
  if (matches.length === 0) {
    const list = manifest.grafts.map(describe).join("\n") || "  (none)";
    throw new Error(`No Graft name, ID, Source URL, or destination matches "${query}". Known Grafts:\n${list}`);
  }
  if (matches.length > 1) {
    throw new Error(`"${query}" matches ${matches.length} sources; be more specific:\n${matches.map(describe).join("\n")}`);
  }
  const source = matches[0]!;

  const deletedFiles: string[] = [];
  if (opts.hard) {
    for (const rel of Object.keys(source.files).sort()) {
      const proj = projectPath(source.dest, rel);
      const abs = managedFilePath(root, proj);
      if (existsSync(abs)) {
        journal.remove(proj);
        deletedFiles.push(proj);
      }
    }
  }

  for (const intent of manifest.intents) {
    intent.targets = intent.targets.map((target) =>
      target.kind === "graft-file" && target.graftId === source.id
        ? { kind: "legacy-orphan" as const, path: target.path, hash: target.hash }
        : target,
    );
  }
  manifest.grafts = manifest.grafts.filter((graft) => graft !== source);
  journal.capture(MANIFEST_FILE);
  journal.capture(PATCH_MD_FILE);
  saveManifest(root, manifest);
  // Intents are kept as history; regeneration marks newly orphaned ones.
  writePatchMd(root, manifest);

  return {
    command: "remove",
    exitCode: 0,
    hard: opts.hard ?? false,
    removed: {
      id: source.id,
      name: source.name,
      url: source.url,
      remoteRef: source.remoteRef,
      path: source.path,
      dest: source.dest,
    },
    deletedFiles,
  };
}
