import { existsSync, mkdirSync, readdirSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const WORKDIR_NAME = ".regraft";

/**
 * Walk upward from cwd looking for a directory containing regraft.json.
 * Falls back to cwd itself (the case for `regraft add` in a fresh project).
 */
export function findRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, "regraft.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

/** Create .regraft/ with a self-ignoring .gitignore. Returns its path. */
export function ensureWorkdir(root: string): string {
  const dir = join(root, WORKDIR_NAME);
  mkdirSync(dir, { recursive: true });
  const gitignore = join(dir, ".gitignore");
  if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n");
  return dir;
}

export function cacheRoot(root: string): string {
  return join(ensureWorkdir(root), "cache");
}

export function briefsDir(root: string): string {
  return join(ensureWorkdir(root), "briefs");
}

/**
 * Project-root-relative path of a tracked file.
 * rel === "" means the source is a single file and dest IS the file.
 */
export function projectPath(dest: string, rel: string): string {
  return rel === "" ? dest : `${dest}/${rel}`;
}

/** Upstream repo path of a tracked file (source.path joined with rel). */
export function upstreamPath(sourcePath: string, rel: string): string {
  if (rel === "") return sourcePath;
  return sourcePath === "" ? rel : `${sourcePath}/${rel}`;
}

/** Normalize a user-supplied project-relative path. */
export function normalizeUserPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Write a file, creating parent directories as needed. */
export function writeFileEnsuringDir(absPath: string, data: Buffer | string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, data);
}

/** Remove now-empty directories, walking up from startRelDir toward root. */
export function pruneEmptyDirs(root: string, startRelDir: string): void {
  let dir = startRelDir;
  while (dir && dir !== "." && dir !== "/" && dir !== "..") {
    const abs = join(root, dir);
    try {
      if (!existsSync(abs) || readdirSync(abs).length > 0) break;
      rmdirSync(abs);
    } catch {
      break;
    }
    dir = dirname(dir);
  }
}
