import { hashFileIfExists } from "./hash";
import type { Graft, GraftFile, Intent, Manifest, PendingReconciliation } from "./manifest";
import { managedFilePath, projectPath } from "./workspace";

export type FileStatus =
  | "clean"
  | "modified+intent"
  | "modified-unrecorded"
  | "missing"
  | "conflict-unresolved"
  | "reconciliation-pending";

export interface ClassifyInput {
  upstreamHash: string | null;
  localHash: string | null;
  diskHash: string | null;
  pending: PendingReconciliation | null;
  intentIds: readonly string[];
  needsIntent: boolean;
}

export function classifyFile(input: ClassifyInput): FileStatus {
  if (input.pending?.kind === "content-conflict" || input.pending?.kind === "legacy-conflict") {
    return "conflict-unresolved";
  }
  if (input.pending) return "reconciliation-pending";
  if (input.diskHash !== input.localHash) {
    return input.diskHash === null && input.localHash !== null ? "missing" : "modified-unrecorded";
  }
  if (input.diskHash === input.upstreamHash) return "clean";
  if (input.needsIntent || input.intentIds.length === 0) return "modified-unrecorded";
  return "modified+intent";
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** Compatibility helper used by renderers and tests: path -> all historical hashes. */
export function intentHashesByPath(intents: readonly Intent[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const intent of intents) {
    for (const target of intent.targets) {
      if (target.hash === null) continue;
      let set = map.get(target.path);
      if (!set) {
        set = new Set();
        map.set(target.path, set);
      }
      set.add(target.hash);
    }
  }
  return map;
}

export function intentHashesFor(map: ReadonlyMap<string, Set<string>>, path: string): ReadonlySet<string> {
  return map.get(path) ?? EMPTY_SET;
}

export function classifyGraftFile(root: string, graft: Graft, rel: string, file: GraftFile): FileStatus {
  const path = projectPath(graft.dest, rel);
  return classifyFile({
    upstreamHash: file.upstreamHash,
    localHash: file.localHash,
    diskHash: hashFileIfExists(managedFilePath(root, path)),
    pending: file.pending,
    intentIds: file.intentIds,
    needsIntent: file.needsIntent,
  });
}

/** Project-relative tracked files with current local state lacking Intent. */
export function findUnrecordedModifications(
  root: string,
  manifest: Manifest,
  selectedGrafts: readonly Graft[] = manifest.grafts,
): string[] {
  const result: string[] = [];
  for (const graft of selectedGrafts) {
    for (const [rel, file] of Object.entries(graft.files)) {
      if (classifyGraftFile(root, graft, rel, file) === "modified-unrecorded") {
        result.push(projectPath(graft.dest, rel));
      }
    }
  }
  return result.sort();
}
