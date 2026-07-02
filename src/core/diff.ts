import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Unified diff between two buffers, rendered by `git diff --no-index` with
 * the project-relative path as both labels (a/<path> vs b/<path> layout).
 * Returns "" when the contents are identical.
 */
export function unifiedDiff(projPath: string, before: Buffer, after: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "regraft-diff-"));
  try {
    const beforePath = join(dir, "a", projPath);
    const afterPath = join(dir, "b", projPath);
    mkdirSync(dirname(beforePath), { recursive: true });
    mkdirSync(dirname(afterPath), { recursive: true });
    writeFileSync(beforePath, before);
    writeFileSync(afterPath, after);
    try {
      execFileSync(
        "git",
        ["-C", dir, "diff", "--no-index", "--no-prefix", "--", `a/${projPath}`, `b/${projPath}`],
        { maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
      );
      return "";
    } catch (err) {
      // git diff --no-index exits 1 when the files differ.
      const e = err as { status?: number | null; stdout?: Buffer };
      if (e.status === 1 && e.stdout) return e.stdout.toString("utf8");
      throw new Error(`git diff failed: ${(err as Error).message}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
