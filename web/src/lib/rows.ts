import { diffLines } from "diff";
import type { UiReviewRegion, UiSegment } from "./types";

export interface CodeLine {
  no: number;
  text: string;
  changed: boolean;
}

export type PaneRow =
  | { kind: "line"; line: CodeLine }
  | { kind: "fold"; id: number; count: number; lines: CodeLine[] };

const FOLD_CONTEXT = 3;
const FOLD_MIN_HIDDEN = 8;

function splitPlain(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Lines of `text` with a changed flag computed against `base`
 * (changed = the line was added or modified relative to base).
 */
export function linesVsBase(text: string, base: string | null): CodeLine[] {
  const plain = splitPlain(text);
  if (base === null) {
    return plain.map((line, index) => ({ no: index + 1, text: line, changed: false }));
  }
  const changed = new Set<number>();
  let lineNo = 1;
  for (const part of diffLines(base, text)) {
    const count = part.count ?? splitPlain(part.value).length;
    if (part.removed) continue;
    if (part.added) {
      for (let i = 0; i < count; i += 1) changed.add(lineNo + i);
    }
    lineNo += count;
  }
  return plain.map((line, index) => ({ no: index + 1, text: line, changed: changed.has(index + 1) }));
}

/** Collapse long unchanged runs into fold rows, keeping context around changes. */
export function foldRows(lines: CodeLine[], expandedFolds: ReadonlySet<number>): PaneRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i]!.changed) continue;
    for (let j = Math.max(0, i - FOLD_CONTEXT); j <= Math.min(lines.length - 1, i + FOLD_CONTEXT); j += 1) {
      keep[j] = true;
    }
  }
  // Always keep a little context at the very top and bottom of the file.
  for (let i = 0; i < Math.min(FOLD_CONTEXT, lines.length); i += 1) keep[i] = true;
  for (let i = Math.max(0, lines.length - FOLD_CONTEXT); i < lines.length; i += 1) keep[i] = true;

  const rows: PaneRow[] = [];
  let foldId = 0;
  let i = 0;
  while (i < lines.length) {
    if (keep[i]) {
      rows.push({ kind: "line", line: lines[i]! });
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && !keep[j]) j += 1;
    const hidden = lines.slice(i, j);
    if (hidden.length < FOLD_MIN_HIDDEN || expandedFolds.has(foldId)) {
      for (const line of hidden) rows.push({ kind: "line", line });
      if (hidden.length >= FOLD_MIN_HIDDEN) foldId += 1;
    } else {
      rows.push({ kind: "fold", id: foldId, count: hidden.length, lines: hidden });
      foldId += 1;
    }
    i = j;
  }
  return rows;
}

/* ---------- result pane (working file with conflict blocks) ---------- */

export interface ConflictRegion {
  index: number;
  local: string;
  base: string;
  upstream: string;
  /** 1-based line in the on-disk marker file where this region starts. */
  lineStart: number;
}

export type ResultRow =
  | { kind: "line"; line: CodeLine }
  | { kind: "fold"; id: number; count: number; lines: CodeLine[] }
  | { kind: "conflict"; region: ConflictRegion };

function countLines(text: string): number {
  return splitPlain(text).length;
}

/**
 * Rows for the proposed-result pane: plain segments become numbered lines
 * (numbers match the on-disk file, marker lines included), conflict
 * segments become interactive regions.
 */
export function resultRows(segments: UiSegment[], expandedFolds: ReadonlySet<number>): ResultRow[] {
  const rows: ResultRow[] = [];
  let lineNo = 1;
  let foldId = 0;

  for (let s = 0; s < segments.length; s += 1) {
    const segment = segments[s]!;
    if (segment.type === "conflict") {
      rows.push({
        kind: "conflict",
        region: {
          index: segment.index,
          local: segment.local,
          base: segment.base,
          upstream: segment.upstream,
          lineStart: lineNo,
        },
      });
      // Marker lines on disk: start + local + (base marker + base) + divider + upstream + end.
      lineNo += 3 + countLines(segment.local) + countLines(segment.upstream);
      lineNo += segment.base === "" ? 0 : 1 + countLines(segment.base);
      if (segment.base === "") lineNo += 1; // diff3 always writes the ||||||| marker; base may be empty
      continue;
    }

    const lines = splitPlain(segment.text).map((text, index) => ({
      no: lineNo + index,
      text,
      changed: false,
    }));
    lineNo += lines.length;

    const first = s === 0;
    const last = s === segments.length - 1;
    const head = first ? FOLD_CONTEXT : FOLD_CONTEXT;
    const tail = last ? FOLD_CONTEXT : FOLD_CONTEXT;
    if (lines.length >= head + tail + FOLD_MIN_HIDDEN) {
      for (const line of lines.slice(0, head)) rows.push({ kind: "line", line });
      const hidden = lines.slice(head, lines.length - tail);
      if (expandedFolds.has(foldId)) {
        for (const line of hidden) rows.push({ kind: "line", line });
      } else {
        rows.push({ kind: "fold", id: foldId, count: hidden.length, lines: hidden });
      }
      foldId += 1;
      for (const line of lines.slice(lines.length - tail)) rows.push({ kind: "line", line });
    } else {
      for (const line of lines) rows.push({ kind: "line", line });
    }
  }
  return rows;
}

/* ---------- review rows (working file with decision regions) ---------- */

export type ReviewRow =
  | { kind: "line"; line: CodeLine }
  | { kind: "fold"; id: number; count: number; lines: CodeLine[] }
  | { kind: "region"; region: UiReviewRegion };

/**
 * Rows for the proposed-result pane when decision regions are known: stable
 * text becomes numbered lines (numbers match the on-disk working file),
 * every region — open or already decided — becomes a block.
 */
export function reviewResultRows(
  working: string,
  regions: UiReviewRegion[],
  expandedFolds: ReadonlySet<number>,
): ReviewRow[] {
  const rows: ReviewRow[] = [];
  let foldId = 0;

  const pushStable = (text: string, startLine: number): void => {
    const lines = splitPlain(text).map((line, index) => ({ no: startLine + index, text: line, changed: false }));
    if (lines.length >= FOLD_CONTEXT * 2 + FOLD_MIN_HIDDEN) {
      for (const line of lines.slice(0, FOLD_CONTEXT)) rows.push({ kind: "line", line });
      const hidden = lines.slice(FOLD_CONTEXT, lines.length - FOLD_CONTEXT);
      if (expandedFolds.has(foldId)) {
        for (const line of hidden) rows.push({ kind: "line", line });
      } else {
        rows.push({ kind: "fold", id: foldId, count: hidden.length, lines: hidden });
      }
      foldId += 1;
      for (const line of lines.slice(lines.length - FOLD_CONTEXT)) rows.push({ kind: "line", line });
    } else {
      for (const line of lines) rows.push({ kind: "line", line });
    }
  };

  const sorted = [...regions].sort((a, b) => a.start - b.start);
  let cursor = 0;
  let lineNo = 1;
  for (const region of sorted) {
    const stable = working.slice(cursor, region.start);
    if (stable !== "") {
      pushStable(stable, lineNo);
      lineNo += splitPlain(stable).length;
    }
    rows.push({ kind: "region", region });
    lineNo += splitPlain(region.text).length;
    cursor = region.end;
  }
  const tail = working.slice(cursor);
  if (tail !== "") pushStable(tail, lineNo);
  return rows;
}

/** Best-effort line locator for a slice of text inside a full pane text. */
export function locateSlice(paneText: string, slice: string): number | null {
  const sliceLines = splitPlain(slice);
  const firstMeaningful = sliceLines.find((line) => line.trim() !== "");
  if (firstMeaningful === undefined) return null;
  const lines = splitPlain(paneText);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === firstMeaningful) return i + 1;
  }
  return null;
}
