import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
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
  let dir = managedFilePath(root, WORKDIR_NAME);
  mkdirSync(dir, { recursive: true });
  dir = managedFilePath(root, WORKDIR_NAME);
  const gitignorePath = `${WORKDIR_NAME}/.gitignore`;
  const gitignore = managedFilePath(root, gitignorePath);
  if (!existsSync(gitignore)) writeFileEnsuringDir(root, gitignorePath, "*\n");
  return dir;
}

export function cacheRoot(root: string): string {
  ensureWorkdir(root);
  return managedFilePath(root, `${WORKDIR_NAME}/cache`);
}

export function briefsDir(root: string): string {
  ensureWorkdir(root);
  return managedFilePath(root, `${WORKDIR_NAME}/briefs`);
}

/**
 * Project-root-relative path of a tracked file.
 * rel === "" means the source is a single file and dest IS the file.
 */
export function projectPath(dest: string, rel: string): string {
  const safeDest = assertSafeProjectPath(dest, "dest");
  const safeRel = assertSafeProjectPath(rel, "tracked file path", { allowEmpty: true });
  return safeRel === "" ? safeDest : `${safeDest}/${safeRel}`;
}

/** Upstream repo path of a tracked file (source.path joined with rel). */
export function upstreamPath(sourcePath: string, rel: string): string {
  if (rel === "") return sourcePath;
  return sourcePath === "" ? rel : `${sourcePath}/${rel}`;
}

/** Normalize a user-supplied project-relative path. */
export function normalizeUserPath(p: string): string {
  const normalized = normalizeProjectPathText(p);
  return assertSafeProjectPath(normalized, "path", { allowEmpty: true });
}

function normalizeProjectPathText(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

export function assertSafeProjectPath(p: string, label = "path", opts: { allowEmpty?: boolean } = {}): string {
  let normalized = normalizeProjectPathText(p);
  if (normalized === "") {
    if (opts.allowEmpty) return normalized;
    throw new Error(`${label} must not be empty.`);
  }
  if (normalized.includes("\0")) throw new Error(`${label} must be project-relative and must not contain NUL bytes.`);
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`${label} must be project-relative, not absolute: ${p}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) {
    throw new Error(`${label} must be project-relative and must not contain ".." segments: ${p}`);
  }
  normalized = parts.filter((part) => part !== ".").join("/");
  if (normalized === "") {
    if (opts.allowEmpty) return normalized;
    throw new Error(`${label} must not be empty.`);
  }
  return normalized;
}

/**
 * Resolve a managed project file without following symlinks below the project
 * root. A missing component is safe; later components cannot exist yet.
 */
export function managedFilePath(root: string, projectRelativePath: string): string {
  const safePath = assertSafeProjectPath(projectRelativePath, "managed file path");
  const absoluteRoot = realpathSync(resolve(root));
  const parts = safePath.split("/");
  let current = absoluteRoot;

  for (let i = 0; i < parts.length; i += 1) {
    current = join(current, parts[i] as string);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        const component = parts.slice(0, i + 1).join("/");
        throw new Error(
          `Refusing to access "${safePath}": "${component}" is a symbolic link. ` +
            "Regraft does not follow symlinks in managed paths.",
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      throw err;
    }
  }

  return join(absoluteRoot, ...parts);
}

/** Write a managed project file, creating non-symlink parent directories as needed. */
export function writeFileEnsuringDir(root: string, projectRelativePath: string, data: Buffer | string): void {
  let absPath = managedFilePath(root, projectRelativePath);
  mkdirSync(dirname(absPath), { recursive: true });
  // Check again after directory creation so every newly established component
  // is covered before the write.
  absPath = managedFilePath(root, projectRelativePath);
  writeFileSync(absPath, data);
}

/** Remove now-empty directories, walking up from startRelDir toward root. */
export function pruneEmptyDirs(root: string, startRelDir: string): void {
  let dir = startRelDir;
  while (dir && dir !== "." && dir !== "/" && dir !== "..") {
    const abs = managedFilePath(root, dir);
    try {
      if (!existsSync(abs) || readdirSync(abs).length > 0) break;
      rmdirSync(abs);
    } catch {
      break;
    }
    dir = dirname(dir);
  }
}
