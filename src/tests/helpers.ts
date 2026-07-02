import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const createdDirs: string[] = [];

export function makeTempDir(prefix = "regraft-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
  createdDirs.length = 0;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function writeFiles(dir: string, files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

export interface Upstream {
  dir: string;
  url: string;
  sha: string;
}

/** Create a local git repo (branch `main`) with an initial commit, usable via file:// */
export function initUpstream(files: Record<string, string | Buffer>): Upstream {
  const dir = makeTempDir("regraft-upstream-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "regraft-test");
  git(dir, "config", "core.autocrlf", "false");
  writeFiles(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "v1");
  return { dir, url: `file://${dir}`, sha: git(dir, "rev-parse", "HEAD").trim() };
}

/** Commit changes (writes + removals) to an upstream fixture. Returns the new SHA. */
export function commitUpstream(
  upstream: Upstream,
  files: Record<string, string | Buffer>,
  options: { remove?: string[]; message?: string } = {},
): string {
  writeFiles(upstream.dir, files);
  for (const path of options.remove ?? []) rmSync(join(upstream.dir, path), { force: true });
  git(upstream.dir, "add", "-A");
  git(upstream.dir, "commit", "-q", "-m", options.message ?? "update");
  const sha = git(upstream.dir, "rev-parse", "HEAD").trim();
  upstream.sha = sha;
  return sha;
}

/** Create an empty project directory (regraft does not require it to be a git repo). */
export function makeProject(): string {
  return makeTempDir("regraft-project-");
}
