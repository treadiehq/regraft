import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGit, gitText } from "../core/git";

/** Public install scripts — used to re-download standalone binary installs. */
const INSTALL_URL = "https://raw.githubusercontent.com/treadiehq/regraft/main/scripts/install.sh";
const INSTALL_URL_PS1 = "https://raw.githubusercontent.com/treadiehq/regraft/main/scripts/install.ps1";

function out(line = ""): void {
  process.stdout.write(line + "\n");
}

function fail(line: string): void {
  process.stderr.write(`error: ${line}\n`);
}

function hasCommand(cmd: string): boolean {
  const probe = spawnSync(cmd, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
  return probe.status === 0;
}

function run(cmd: string, args: string[], cwd: string): number {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  return r.status ?? 1;
}

function safeGit(root: string, args: string[]): string | null {
  try {
    return gitText(args, { cwd: root }).trim();
  } catch {
    return null;
  }
}

function pkgVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "?";
  } catch {
    return "?";
  }
}

type InstallKind = "git" | "package";

/**
 * Walk up from the running entry file to figure out how regraft is installed:
 * a git checkout (dev clone / from-source install, has `.git` + `package.json`),
 * a package-manager install (a `regraft` package.json inside `node_modules`),
 * or neither — which means we are a standalone compiled binary.
 */
export function findInstallRoot(startFile: string): { dir: string; kind: InstallKind } | null {
  let dir = dirname(startFile);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "package.json"))) {
      if (existsSync(join(dir, ".git"))) return { dir, kind: "git" };
      if (basename(dirname(dir)) === "node_modules" || basename(dirname(dirname(dir))) === "node_modules") {
        try {
          const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
          if (pkg.name === "regraft") return { dir, kind: "package" };
        } catch {
          // unreadable package.json — keep walking
        }
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Self-update. A git checkout is updated in place (pull + rebuild); a
 * package-manager install defers to that package manager; a standalone binary
 * is refreshed by re-running the public installer, which downloads the latest
 * released binary for this platform.
 */
export function updateCommand(version?: string): number {
  const root = findInstallRoot(fileURLToPath(import.meta.url));
  if (root?.kind === "git") return updateFromSource(root.dir, version);
  if (root?.kind === "package") {
    out("regraft was installed with a package manager — update it there instead:");
    out("  npm update -g regraft    # or: pnpm update -g regraft");
    return 0;
  }
  return updateBinary(version);
}

/** Re-run the installer to download the latest released binary for this platform. */
function updateBinary(version?: string): number {
  const env = { ...process.env };
  if (version) env.REGRAFT_VERSION = version;
  const target = version ?? "latest";

  if (process.platform === "win32") {
    const pwsh = hasCommand("pwsh") ? "pwsh" : "powershell";
    out(`Updating regraft (${target} release)`);
    // The installer renames the running regraft.exe aside before writing the new
    // one, so an in-place self-update works even though Windows locks the live binary.
    const status = spawnSync(pwsh, ["-NoProfile", "-Command", `irm ${INSTALL_URL_PS1} | iex`], {
      env,
      stdio: "inherit",
    }).status;
    if (status !== 0) return 1;
    out("regraft updated. Open a new terminal and run `regraft --version` to confirm.");
    return 0;
  }

  if (!hasCommand("bash") || !hasCommand("curl")) {
    fail("self-update needs `curl` and `bash` on PATH.");
    out(`Re-run the installer manually:  curl -fsSL ${INSTALL_URL} | bash`);
    return 1;
  }

  out(`Updating regraft (${target} release)`);
  // Replacing the currently-running binary is safe on Unix: this process keeps
  // the old inode while the installer writes the new file into place.
  // pipefail: without it a failed download exits 0 (bash succeeds on empty input).
  const status = spawnSync("bash", ["-c", `set -o pipefail; curl -fsSL ${INSTALL_URL} | bash`], {
    env,
    stdio: "inherit",
  }).status;
  if (status !== 0) return 1;
  out("regraft updated. Run `regraft --version` to confirm.");
  return 0;
}

/** Pull the latest source into a git checkout and rebuild, mirroring a from-source install. */
function updateFromSource(root: string, ref?: string): number {
  out(`Updating regraft in ${root}`);

  // Refuse to clobber a checkout with local edits (e.g. a dev clone).
  const dirty = safeGit(root, ["status", "--porcelain"]);
  if (dirty === null) {
    fail(`could not read git status in ${root}.`);
    return 1;
  }
  if (dirty) {
    fail("the install directory has local changes — refusing to update.");
    out("Commit/stash them, or reinstall, then try again.");
    return 1;
  }

  const oldVersion = pkgVersion(root);
  let target = ref;
  if (!target) {
    const branch = safeGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "HEAD";
    target = branch && branch !== "HEAD" ? branch : "main";
  }

  const before = safeGit(root, ["rev-parse", "HEAD"]) ?? "";
  out(`  fetching ${target}`);
  try {
    runGit(["fetch", "--depth", "1", "origin", target], { cwd: root });
  } catch (err) {
    fail((err as Error).message);
    return 1;
  }
  const fetched = safeGit(root, ["rev-parse", "FETCH_HEAD"]) ?? "";

  if (before && fetched && before === fetched) {
    out(`Already up to date (v${oldVersion}).`);
    return 0;
  }

  runGit(["checkout", "-q", "FETCH_HEAD"], { cwd: root });

  const pm = hasCommand("pnpm") ? "pnpm" : "npm";
  out(`  installing dependencies (${pm})`);
  if (run(pm, ["install"], root) !== 0) return 1;
  out("  building");
  if (run(pm, ["run", "build"], root) !== 0) return 1;

  if (!existsSync(join(root, "dist", "cli.js"))) {
    fail("build did not produce dist/cli.js.");
    return 1;
  }

  const newVersion = pkgVersion(root);
  if (oldVersion === newVersion) {
    out(`Updated to the latest ${target} (v${newVersion}).`);
  } else {
    out(`Updated regraft v${oldVersion} → v${newVersion}.`);
  }
  return 0;
}
