import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { requireManifest, saveManifest } from "../core/manifest";
import { writePatchMd } from "../core/patchmd";
import { findRoot, managedFilePath, normalizeUserPath, projectPath, pruneEmptyDirs } from "../core/workspace";

export interface RemoveOptions {
  cwd: string;
  hard?: boolean;
}

export interface RemoveResult {
  command: "remove";
  exitCode: 0;
  hard: boolean;
  removed: {
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
  const manifest = requireManifest(root);

  const describe = (s: { url: string; path: string; dest: string }): string =>
    `  ${s.url}${s.path ? `#${s.path}` : ""} → ${s.dest}`;

  const destQuery = normalizeUserPath(query);
  const matches = manifest.sources.filter(
    (s) => s.url.includes(query) || (destQuery !== "" && s.dest.includes(destQuery)),
  );
  if (matches.length === 0) {
    const list = manifest.sources.map(describe).join("\n") || "  (none)";
    throw new Error(`No tracked source URL or dest contains "${query}". Tracked sources:\n${list}`);
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
        rmSync(abs);
        deletedFiles.push(proj);
        pruneEmptyDirs(root, dirname(proj));
      }
    }
    pruneEmptyDirs(root, source.dest);
  }

  manifest.sources = manifest.sources.filter((s) => s !== source);
  saveManifest(root, manifest);
  // Intents are kept as history; regeneration marks newly orphaned ones.
  writePatchMd(root, manifest);

  return {
    command: "remove",
    exitCode: 0,
    hard: opts.hard ?? false,
    removed: { url: source.url, remoteRef: source.remoteRef, path: source.path, dest: source.dest },
    deletedFiles,
  };
}
