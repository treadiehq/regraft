import { join } from "node:path";
import { hashFileIfExists } from "./hash";
import type { Intent, Manifest } from "./manifest";
import { projectPath } from "./workspace";

export type FileStatus =
  | "clean"
  | "modified+intent"
  | "modified-unrecorded"
  | "missing"
  | "conflict-unresolved";

export interface ClassifyInput {
  /** sha256 regraft last wrote for this file. */
  storedHash: string;
  /** sha256 of the file currently on disk, or null if missing. */
  diskHash: string | null;
  /** Is this file listed in the source's unresolved conflicts? */
  unresolved: boolean;
  /** All intent-snapshot hashes recorded for this file. */
  intentHashes: ReadonlySet<string>;
}

/**
 * The deterministic three-hash classification:
 * unresolved wins, then missing, then stored-vs-disk, then intent coverage.
 */
export function classifyFile(input: ClassifyInput): FileStatus {
  if (input.unresolved) return "conflict-unresolved";
  if (input.diskHash === null) return "missing";
  if (input.diskHash === input.storedHash) return "clean";
  if (input.intentHashes.has(input.diskHash)) return "modified+intent";
  return "modified-unrecorded";
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** Build a lookup: project-relative path -> set of intent-snapshot hashes. */
export function intentHashesByPath(intents: readonly Intent[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const intent of intents) {
    for (const [path, hash] of Object.entries(intent.files)) {
      let set = map.get(path);
      if (!set) {
        set = new Set();
        map.set(path, set);
      }
      set.add(hash);
    }
  }
  return map;
}

export function intentHashesFor(map: ReadonlyMap<string, Set<string>>, path: string): ReadonlySet<string> {
  return map.get(path) ?? EMPTY_SET;
}

/**
 * Project-relative paths of tracked files whose disk content differs from the
 * stored hash and is not covered by any intent snapshot at its current hash.
 * Unresolved conflicts and missing files are excluded. Sorted.
 */
export function findUnrecordedModifications(root: string, manifest: Manifest): string[] {
  const intentHashes = intentHashesByPath(manifest.intents);
  const result: string[] = [];
  for (const source of manifest.sources) {
    for (const [rel, storedHash] of Object.entries(source.files)) {
      if (source.unresolved.includes(rel)) continue;
      const proj = projectPath(source.dest, rel);
      const diskHash = hashFileIfExists(join(root, proj));
      if (diskHash === null || diskHash === storedHash) continue;
      if (intentHashes.get(proj)?.has(diskHash)) continue;
      result.push(proj);
    }
  }
  return result.sort();
}
