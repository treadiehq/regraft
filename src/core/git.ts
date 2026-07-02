import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./hash";

const MAX_BUFFER = 512 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{40}$/;

export class GitError extends Error {}

export function runGit(args: string[], opts: { cwd?: string } = {}): Buffer {
  try {
    return execFileSync("git", args, {
      cwd: opts.cwd,
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    if (e.code === "ENOENT") {
      throw new Error("git was not found on PATH. regraft requires git to fetch upstream sources.");
    }
    const stderr = e.stderr ? e.stderr.toString("utf8").trim() : "";
    throw new GitError(`git ${args.join(" ")} failed${stderr ? `:\n${stderr}` : ""}`);
  }
}

export function gitText(args: string[], opts: { cwd?: string } = {}): string {
  return runGit(args, opts).toString("utf8");
}

/** Fail fast with a clear error if git is missing. */
export function ensureGitAvailable(): void {
  runGit(["--version"]);
}

export interface RemoteHead {
  sha: string;
  /** The ref name pulls should track (e.g. "main"). */
  ref: string;
}

/**
 * Resolve a ref on a remote to a SHA without fetching.
 * With no ref, resolves the remote HEAD and reports the default branch name.
 */
export function resolveRemote(url: string, ref?: string): RemoteHead {
  if (ref && SHA_RE.test(ref)) return { sha: ref, ref };
  if (!ref) {
    const out = gitText(["ls-remote", "--symref", url, "HEAD"]);
    const symMatch = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m);
    const shaMatch = out.match(/^([0-9a-f]{40})\s+HEAD$/m);
    const sha = shaMatch?.[1];
    if (!sha) throw new Error(`Could not resolve HEAD of ${url}. Is the URL correct and reachable?`);
    return { sha, ref: symMatch?.[1] ?? "HEAD" };
  }
  const out = gitText(["ls-remote", url, ref, `refs/heads/${ref}`, `refs/tags/${ref}`]);
  const lines = out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, name] = line.split(/\s+/);
      return { sha: sha ?? "", name: name ?? "" };
    })
    .filter((l) => SHA_RE.test(l.sha));
  const pick =
    lines.find((l) => l.name === `refs/heads/${ref}`) ??
    lines.find((l) => l.name === `refs/tags/${ref}`) ??
    lines[0];
  if (!pick) throw new Error(`Ref "${ref}" was not found on ${url}.`);
  return { sha: pick.sha, ref };
}

function cacheDirFor(cacheRootDir: string, url: string): string {
  const slug = url
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-60);
  return join(cacheRootDir, `${slug}-${sha256(url).slice(0, 10)}`);
}

/** Get (creating if needed) the bare cache repo for a URL. */
export function ensureCacheRepo(cacheRootDir: string, url: string): string {
  const dir = cacheDirFor(cacheRootDir, url);
  if (!existsSync(join(dir, "HEAD"))) {
    mkdirSync(dir, { recursive: true });
    runGit(["init", "--bare", "--quiet"], { cwd: dir });
  }
  return dir;
}

export function hasCommit(cacheDir: string, sha: string): boolean {
  try {
    runGit(["cat-file", "-e", `${sha}^{commit}`], { cwd: cacheDir });
    return true;
  } catch {
    return false;
  }
}

/** Fetch a ref from the remote into the cache; returns the fetched tip SHA. */
export function fetchRef(cacheDir: string, url: string, ref: string): string {
  runGit(["fetch", "--quiet", "--force", url, ref], { cwd: cacheDir });
  return gitText(["rev-parse", "FETCH_HEAD"], { cwd: cacheDir }).trim();
}

/**
 * Make sure the resolved head commit is present in the cache.
 * Returns the SHA actually available (the freshly fetched tip if the
 * branch moved between ls-remote and fetch).
 */
export function ensureHead(cacheDir: string, url: string, head: RemoteHead): string {
  if (hasCommit(cacheDir, head.sha)) return head.sha;
  if (SHA_RE.test(head.ref)) {
    ensureCommit(cacheDir, url, head.sha);
    return head.sha;
  }
  const fetchedSha = fetchRef(cacheDir, url, head.ref);
  if (hasCommit(cacheDir, head.sha)) return head.sha;
  return fetchedSha;
}

/** Make sure a specific commit is present, fetching the ref and then the raw SHA as fallbacks. */
export function ensureCommit(cacheDir: string, url: string, sha: string, ref?: string): void {
  if (hasCommit(cacheDir, sha)) return;
  if (ref && !SHA_RE.test(ref)) {
    try {
      fetchRef(cacheDir, url, ref);
    } catch {
      // fall through to fetching the SHA directly
    }
    if (hasCommit(cacheDir, sha)) return;
  }
  try {
    runGit(["fetch", "--quiet", url, sha], { cwd: cacheDir });
  } catch (err) {
    throw new Error(
      `Could not fetch commit ${sha} from ${url}. ` +
        `The server may not allow fetching arbitrary SHAs, or the commit may have been garbage-collected.\n` +
        `${(err as Error).message}`,
    );
  }
  if (!hasCommit(cacheDir, sha)) {
    throw new Error(`Commit ${sha} is still missing after fetching from ${url}.`);
  }
}

export function pathKind(cacheDir: string, sha: string, path: string): "file" | "dir" | "missing" {
  if (path === "") return "dir";
  try {
    const t = gitText(["cat-file", "-t", `${sha}:${path}`], { cwd: cacheDir }).trim();
    if (t === "blob") return "file";
    if (t === "tree") return "dir";
    return "missing";
  } catch {
    return "missing";
  }
}

/**
 * List files at a commit under a subpath, relative to that subpath.
 * Returns [""] if the subpath is itself a file, [] if it does not exist.
 */
export function listFilesAt(cacheDir: string, sha: string, path: string): string[] {
  const kind = pathKind(cacheDir, sha, path);
  if (kind === "missing") return [];
  if (kind === "file") return [""];
  const args = ["ls-tree", "-r", "--name-only", "-z", sha];
  if (path !== "") args.push(path);
  const out = runGit(args, { cwd: cacheDir }).toString("utf8");
  const names = out.split("\0").filter(Boolean);
  const prefix = path === "" ? "" : `${path}/`;
  return names
    .map((n) => (prefix && n.startsWith(prefix) ? n.slice(prefix.length) : n))
    .sort();
}

export function readFileAt(cacheDir: string, sha: string, filePath: string): Buffer {
  return runGit(["cat-file", "blob", `${sha}:${filePath}`], { cwd: cacheDir });
}

/** One-line upstream commit log between two SHAs, scoped to a subpath. */
export function logRange(cacheDir: string, oldSha: string, newSha: string, path: string): string {
  const args = ["log", "--oneline", "--no-decorate", `${oldSha}..${newSha}`];
  if (path !== "") args.push("--", path);
  try {
    return gitText(args, { cwd: cacheDir }).trimEnd();
  } catch {
    return "(commit log unavailable)";
  }
}
