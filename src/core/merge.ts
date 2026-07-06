import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MergeResult {
  content: Buffer;
  conflicted: boolean;
}

export const CONFLICT_LABELS = { ours: "local", base: "base", theirs: "upstream" } as const;

/**
 * Hunk-level three-way merge via `git merge-file --diff3`.
 * Non-overlapping changes merge silently; true conflicts produce inline
 * diff3 markers (`<<<<<<< local` / `||||||| base` / `>>>>>>> upstream`).
 */
export function mergeThreeWay(input: { base: Buffer; ours: Buffer; theirs: Buffer }): MergeResult {
  const dir = mkdtempSync(join(tmpdir(), "regraft-merge-"));
  try {
    const oursPath = join(dir, "ours");
    const basePath = join(dir, "base");
    const theirsPath = join(dir, "theirs");
    writeFileSync(oursPath, input.ours);
    writeFileSync(basePath, input.base);
    writeFileSync(theirsPath, input.theirs);
    const args = [
      "merge-file",
      "-p",
      "--diff3",
      "-L",
      CONFLICT_LABELS.ours,
      "-L",
      CONFLICT_LABELS.base,
      "-L",
      CONFLICT_LABELS.theirs,
      oursPath,
      basePath,
      theirsPath,
    ];
    try {
      const out = execFileSync("git", args, {
        maxBuffer: 512 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { content: out, conflicted: false };
    } catch (err) {
      // git merge-file exits with the number of conflicts (>0) on conflict.
      const e = err as { status?: number | null; stdout?: Buffer };
      if (typeof e.status === "number" && e.status > 0 && e.stdout) {
        return { content: e.stdout, conflicted: true };
      }
      throw new Error(`git merge-file failed: ${(err as Error).message}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MARKER_RE = /^(?:<{7}|\|{7}|>{7}) /m;

/** Detect diff3 conflict markers at line starts. */
export function hasConflictMarkers(content: Buffer | string): boolean {
  const text = typeof content === "string" ? content : content.toString("utf8");
  return MARKER_RE.test(text);
}
