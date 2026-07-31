/**
 * Analysis of how a conflicted file's regions were (or were not) resolved.
 *
 * The diff3 merge of (base, local, upstream) is deterministic, so it can be
 * regenerated at any time and aligned against the current working file. Text
 * between the stable (non-conflicting) parts is whatever the resolver — a
 * human in an editor, an agent, or the review UI — put there, and can be
 * classified against the three sides.
 */

import { hasConflictMarkers, mergeThreeWay, CONFLICT_LABELS } from "./merge";
import { parseConflictFile, type ConflictSegment } from "./conflicts";

export type RegionStatus = "unresolved" | "local" | "upstream" | "base" | "custom";

export interface ResolutionRegion {
  /** Ordinal among all regions of the file, resolved or not. */
  index: number;
  status: RegionStatus;
  /** Text currently occupying this region in the working file. */
  text: string;
  local: string;
  base: string;
  upstream: string;
  /** Character range of `text` within the working file. */
  start: number;
  end: number;
}

export interface ResolutionAnalysis {
  regions: ResolutionRegion[];
  unresolved: number;
}

function classify(chunk: string, segment: ConflictSegment): RegionStatus {
  if (hasConflictMarkers(chunk)) return "unresolved";
  if (chunk === segment.upstream) return "upstream";
  if (chunk === segment.local) return "local";
  if (chunk === segment.base) return "base";
  return "custom";
}

/**
 * Align the regenerated merge against the working file. Returns null when
 * the file cannot be analyzed (no conflicts, stable text was edited, or the
 * layout is ambiguous); callers fall back to the plain marker view.
 */
export function analyzeResolution(input: {
  base: string;
  local: string;
  upstream: string;
  working: string;
}): ResolutionAnalysis | null {
  const merged = mergeThreeWay({
    base: Buffer.from(input.base),
    ours: Buffer.from(input.local),
    theirs: Buffer.from(input.upstream),
  });
  if (!merged.conflicted) return null;
  const model = parseConflictFile(merged.content.toString("utf8"));
  if (model.conflictCount === 0) return null;

  const working = input.working;
  const regions: ResolutionRegion[] = [];
  let cursor = 0;
  let pending: ConflictSegment | null = null;

  const closeRegion = (chunkEnd: number): boolean => {
    if (!pending) return true;
    const start = cursor;
    const text = working.slice(start, chunkEnd);
    regions.push({
      index: pending.index,
      status: classify(text, pending),
      text,
      local: pending.local,
      base: pending.base,
      upstream: pending.upstream,
      start,
      end: chunkEnd,
    });
    pending = null;
    return true;
  };

  for (const segment of model.segments) {
    if (segment.type === "conflict") {
      if (pending) return null; // adjacent conflicts: ambiguous split
      pending = segment;
      continue;
    }
    if (segment.text === "") continue;
    const found = working.indexOf(segment.text, cursor);
    if (found === -1) return null; // stable text edited: cannot align
    if (pending) {
      closeRegion(found);
    } else if (found !== cursor) {
      return null; // unexplained insertion outside any region
    }
    cursor = found + segment.text.length;
  }
  if (pending) closeRegion(working.length);
  else if (cursor !== working.length) return null; // unexplained trailing text

  return { regions, unresolved: regions.filter((region) => region.status === "unresolved").length };
}

function withTrailingNewline(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

/** Marker block for one region, matching what `regraft pull` writes. */
export function markerBlock(region: Pick<ResolutionRegion, "local" | "base" | "upstream">): string {
  return (
    `<<<<<<< ${CONFLICT_LABELS.ours}\n` +
    withTrailingNewline(region.local) +
    `||||||| ${CONFLICT_LABELS.base}\n` +
    withTrailingNewline(region.base) +
    `=======\n` +
    withTrailingNewline(region.upstream) +
    `>>>>>>> ${CONFLICT_LABELS.theirs}\n`
  );
}

/**
 * Put the diff3 markers back for one resolved region, so a decision can be
 * revisited in place. Returns the new working text.
 */
export function reopenRegion(working: string, analysis: ResolutionAnalysis, index: number): string {
  const region = analysis.regions.find((candidate) => candidate.index === index);
  if (!region) throw new Error(`Region #${index + 1} was not found.`);
  if (region.status === "unresolved") throw new Error(`Region #${index + 1} is already open.`);
  return working.slice(0, region.start) + markerBlock(region) + working.slice(region.end);
}
