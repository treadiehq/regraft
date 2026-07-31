import { spawn } from "node:child_process";

/**
 * Open a file in the user's editor, ideally at a specific line.
 *
 * Order: `REGRAFT_EDITOR` (used verbatim, path appended), then common GUI
 * editor CLIs on PATH, then the platform opener. Terminal editors like vim
 * need a TTY the server does not have, so `EDITOR`/`VISUAL` are deliberately
 * not consulted.
 */

interface EditorCandidate {
  bin: string;
  args: (path: string, line: number) => string[];
}

const GUI_EDITORS: EditorCandidate[] = [
  { bin: "cursor", args: (path, line) => ["--goto", `${path}:${line}`] },
  { bin: "code", args: (path, line) => ["--goto", `${path}:${line}`] },
  { bin: "zed", args: (path, line) => [`${path}:${line}`] },
  { bin: "subl", args: (path, line) => [`${path}:${line}`] },
];

function trySpawn(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { stdio: "ignore", detached: true });
    child.once("error", () => resolvePromise(false));
    child.once("spawn", () => {
      child.unref();
      resolvePromise(true);
    });
  });
}

/** Returns the editor command that was launched. */
export async function openInEditor(path: string, line: number): Promise<string> {
  const custom = process.env.REGRAFT_EDITOR?.trim();
  if (custom) {
    const parts = custom.split(/\s+/);
    if (await trySpawn(parts[0]!, [...parts.slice(1), path])) return parts[0]!;
    throw new Error(`REGRAFT_EDITOR ("${custom}") could not be started.`);
  }
  for (const editor of GUI_EDITORS) {
    if (await trySpawn(editor.bin, editor.args(path, line))) return editor.bin;
  }
  const [bin, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [path]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", path]]
        : ["xdg-open", [path]];
  if (await trySpawn(bin, args)) return bin;
  throw new Error("No editor found. Set REGRAFT_EDITOR to your editor command.");
}
