import { spawn } from "node:child_process";
import { ensureGitAvailable } from "../core/git";
import { requireManifest } from "../core/manifest";
import { findRoot } from "../core/workspace";
import { startUiServer, type UiServerHandle } from "../ui/server";

export interface UiOptions {
  cwd: string;
  port?: number;
  /** Open the browser after starting (default true). */
  open?: boolean;
}

/** Open a URL with the platform's default browser, without blocking. */
function openBrowser(url: string): void {
  const platform = process.platform;
  const child =
    platform === "darwin"
      ? spawn("open", [url], { stdio: "ignore", detached: true })
      : platform === "win32"
        ? spawn("cmd", ["/c", "start", "", url.replace(/&/g, "^&")], { stdio: "ignore", detached: true })
        : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  child.on("error", () => {
    // Browser could not be opened automatically; the URL is already printed.
  });
  child.unref();
}

/**
 * Start the local review UI server. Resolves once it is listening; the
 * process stays alive until the returned handle is closed (Ctrl+C).
 */
export async function uiCommand(opts: UiOptions): Promise<UiServerHandle> {
  ensureGitAvailable();
  const root = findRoot(opts.cwd);
  requireManifest(root); // fail fast with the standard "no regraft.json" error
  const handle = await startUiServer({ root, port: opts.port });
  if (opts.open !== false) openBrowser(handle.url);
  return handle;
}
