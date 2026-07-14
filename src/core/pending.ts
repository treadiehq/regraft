import { ensureCacheRepo, ensureCommit, pathKind, readFileAt } from "./git";
import { sha256 } from "./hash";
import type { Graft, GraftFile } from "./manifest";
import { cacheRoot, upstreamPath } from "./workspace";

/** Reconstruct target content for legacy pending state from its pinned Git commit. */
export function hydratePendingTarget(root: string, graft: Graft, rel: string, file: GraftFile): void {
  const pending = file.pending;
  if (!pending || pending.targetKnown) return;
  const cache = ensureCacheRepo(cacheRoot(root), graft.url);
  ensureCommit(cache, graft.url, pending.toSha, graft.remoteRef);
  const path = upstreamPath(graft.path, rel);
  if (pathKind(cache, pending.toSha, path) === "missing") {
    pending.targetHash = null;
  } else {
    pending.targetHash = sha256(readFileAt(cache, pending.toSha, path));
  }
  pending.targetKnown = true;
}
