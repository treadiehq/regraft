import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Hash a file on disk, or return null if it does not exist. */
export function hashFileIfExists(filePath: string): string | null {
  const data = readFileIfExists(filePath);
  return data === null ? null : sha256(data);
}

/** Read a file on disk, or return null if it does not exist. */
export function readFileIfExists(filePath: string): Buffer | null {
  try {
    if (lstatSync(filePath).isSymbolicLink()) {
      throw new Error(`Refusing to follow symbolic link: ${filePath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return readFileSync(filePath);
}

/** Git's heuristic: a NUL byte in the first 8 KiB means binary. */
export function isBinary(data: Buffer): boolean {
  const len = Math.min(data.length, 8192);
  for (let i = 0; i < len; i++) {
    if (data[i] === 0) return true;
  }
  return false;
}
