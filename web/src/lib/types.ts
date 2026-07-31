// Hand-mirrored DTOs from src/ui/state.ts and the command results the
// server proxies. Keep in sync when the server payload changes.

export type FileStatus =
  | "clean"
  | "modified+intent"
  | "modified-unrecorded"
  | "missing"
  | "conflict-unresolved"
  | "reconciliation-pending";

export type PendingKind =
  | "content-conflict"
  | "binary-conflict"
  | "upstream-deleted"
  | "local-deleted"
  | "destination-collision"
  | "ownership-unknown"
  | "legacy-conflict";

export interface UiIntent {
  id: string;
  date: string;
  description: string;
  files: string[];
}

export interface UiCommit {
  sha: string;
  subject: string;
}

export type UiSegment =
  | { type: "text"; text: string }
  | { type: "conflict"; index: number; local: string; base: string; upstream: string };

export type RegionStatus = "unresolved" | "local" | "upstream" | "base" | "custom";

export interface UiReviewRegion {
  /** Ordinal among all decision regions of this file, resolved or not. */
  index: number;
  status: RegionStatus;
  /** Text currently occupying the region in the working file. */
  text: string;
  local: string;
  base: string;
  upstream: string;
  /** Character range of `text` within `working`. */
  start: number;
  end: number;
  /** 1-based line where the region starts in the working file. */
  line: number;
}

export interface UiPending {
  kind: PendingKind;
  headline: string;
  detail: string;
  fromSha: string | null;
  toSha: string;
  brief: string | null;
  binary: boolean;
  base: string | null;
  upstream: string | null;
  local: string | null;
  localExact: boolean;
  working: string | null;
  segments: UiSegment[] | null;
  review: UiReviewRegion[] | null;
  conflictsRemaining: number;
  upstreamCommits: UiCommit[];
}

export interface UiFile {
  path: string;
  rel: string;
  status: FileStatus;
  needsIntent: boolean;
  intents: UiIntent[];
  pending: UiPending | null;
}

export interface UiGraft {
  id: string;
  name: string;
  url: string;
  remoteRef: string;
  sourcePath: string;
  dest: string;
  pinnedSha: string;
  files: UiFile[];
  pendingCount: number;
}

export interface UiSummary {
  grafts: number;
  tracked: number;
  conflicts: number;
  warnings: number;
  mergedClean: number;
  needsNote: number;
}

export interface UiState {
  schemaVersion: 1;
  generatedAt: string;
  project: { name: string; root: string };
  summary: UiSummary;
  grafts: UiGraft[];
}

export interface ResolveResult {
  command: "resolve";
  exitCode: 0 | 1;
  resolved: string[];
  markersRemain: string[];
  needsNote: string[];
  note: { id: string; description: string } | null;
}

export interface PullSourceResult {
  id: string;
  name: string;
  oldSha: string;
  newSha: string;
  upToDate: boolean;
  added: string[];
  fastForwarded: string[];
  merged: string[];
  forced: string[];
  deleted: string[];
  conflicts: string[];
  skipped: { path: string; reason: string }[];
  warnings: { path: string; message: string }[];
}

export interface PullResult {
  command: "pull";
  exitCode: 0 | 1;
  dryRun: boolean;
  conflicts: boolean;
  brief: string | null;
  unrecordedModifications: string[];
  sources: PullSourceResult[];
}

export interface StatusSource {
  id: string;
  name: string;
  pinnedSha: string;
  upstreamSha: string | null;
  stale: boolean | null;
}

export interface StatusResult {
  command: "status";
  exitCode: 0 | 1;
  stale: boolean;
  sources: StatusSource[];
}

export type FileAction = "use-upstream" | "keep-local" | "keep-deleted" | "delete" | "restore-upstream" | "reset";
export type ConflictChoice = "local" | "base" | "upstream" | "custom";
