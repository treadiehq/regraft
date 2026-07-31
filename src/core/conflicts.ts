/**
 * Structured model of a diff3 conflict file, as written by `regraft pull`
 * (`git merge-file --diff3 -L local -L base -L upstream`).
 *
 * The parser is exact: `renderConflictFile(parseConflictFile(text))` returns
 * `text` byte-for-byte for well-formed input, and malformed marker runs are
 * preserved as plain text instead of being reinterpreted.
 */

export interface TextSegment {
  type: "text";
  text: string;
}

export interface ConflictSegment {
  type: "conflict";
  /** 0-based index among the conflict segments of this file. */
  index: number;
  /** Content of the `<<<<<<< local` side (your adapted version). */
  local: string;
  /** Content of the `||||||| base` side (old upstream both sides started from). */
  base: string;
  /** Content of the `>>>>>>> upstream` side (new upstream version). */
  upstream: string;
  /** Raw marker lines, kept so rendering reproduces the file exactly. */
  markers: { start: string; base: string; divider: string; end: string };
}

export type FileSegment = TextSegment | ConflictSegment;

export interface ConflictFileModel {
  segments: FileSegment[];
  conflictCount: number;
}

export type ConflictChoice = "local" | "base" | "upstream" | "custom";

const START_RE = /^<{7}(?: |\r?\n?$)/;
const BASE_RE = /^\|{7}(?: |\r?\n?$)/;
const DIVIDER_RE = /^={7}\r?\n?$/;
const END_RE = /^>{7}(?: |\r?\n?$)/;

/** Split into lines, each keeping its trailing newline (last line may lack one). */
function toLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

export function parseConflictFile(text: string): ConflictFileModel {
  const lines = toLines(text);
  const segments: FileSegment[] = [];
  let conflictCount = 0;
  let plain: string[] = [];

  const flushPlain = (): void => {
    if (plain.length > 0) {
      segments.push({ type: "text", text: plain.join("") });
      plain = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!START_RE.test(line)) {
      plain.push(line);
      i += 1;
      continue;
    }

    // Attempt to read a full diff3 conflict block. On any structural
    // mismatch, fall back to treating the start marker as plain text.
    let cursor = i + 1;
    const local: string[] = [];
    while (cursor < lines.length && !BASE_RE.test(lines[cursor]!) && !DIVIDER_RE.test(lines[cursor]!)) {
      if (START_RE.test(lines[cursor]!) || END_RE.test(lines[cursor]!)) break;
      local.push(lines[cursor]!);
      cursor += 1;
    }
    const baseMarker = cursor < lines.length && BASE_RE.test(lines[cursor]!) ? lines[cursor]! : null;
    const base: string[] = [];
    if (baseMarker !== null) {
      cursor += 1;
      while (cursor < lines.length && !DIVIDER_RE.test(lines[cursor]!)) {
        if (START_RE.test(lines[cursor]!) || END_RE.test(lines[cursor]!) || BASE_RE.test(lines[cursor]!)) break;
        base.push(lines[cursor]!);
        cursor += 1;
      }
    }
    if (cursor >= lines.length || !DIVIDER_RE.test(lines[cursor]!)) {
      plain.push(line);
      i += 1;
      continue;
    }
    const dividerLine = lines[cursor]!;
    cursor += 1;
    const upstream: string[] = [];
    while (cursor < lines.length && !END_RE.test(lines[cursor]!)) {
      if (START_RE.test(lines[cursor]!) || BASE_RE.test(lines[cursor]!) || DIVIDER_RE.test(lines[cursor]!)) break;
      upstream.push(lines[cursor]!);
      cursor += 1;
    }
    if (cursor >= lines.length || !END_RE.test(lines[cursor]!)) {
      plain.push(line);
      i += 1;
      continue;
    }

    flushPlain();
    segments.push({
      type: "conflict",
      index: conflictCount,
      local: local.join(""),
      base: base.join(""),
      upstream: upstream.join(""),
      markers: {
        start: line,
        base: baseMarker ?? "",
        divider: dividerLine,
        end: lines[cursor]!,
      },
    });
    conflictCount += 1;
    i = cursor + 1;
  }

  flushPlain();
  return { segments, conflictCount };
}

/** Render a model back to file text. Unresolved conflicts keep their original markers. */
export function renderConflictFile(model: ConflictFileModel): string {
  const parts: string[] = [];
  for (const segment of model.segments) {
    if (segment.type === "text") {
      parts.push(segment.text);
      continue;
    }
    parts.push(segment.markers.start, segment.local);
    if (segment.markers.base !== "") parts.push(segment.markers.base, segment.base);
    parts.push(segment.markers.divider, segment.upstream, segment.markers.end);
  }
  return parts.join("");
}

/** Reconstruct "your version": every conflict collapsed to its local side. */
export function reconstructLocal(text: string): string {
  const model = parseConflictFile(text);
  return model.segments
    .map((segment) => (segment.type === "text" ? segment.text : segment.local))
    .join("");
}

/**
 * Replace one conflict (by conflict index) with the chosen side and return
 * the new file text. `custom` requires `customText` (may be empty to drop
 * the region entirely).
 */
export function applyConflictChoice(
  text: string,
  conflictIndex: number,
  choice: ConflictChoice,
  customText?: string,
): string {
  const model = parseConflictFile(text);
  const target = model.segments.find(
    (segment): segment is ConflictSegment => segment.type === "conflict" && segment.index === conflictIndex,
  );
  if (!target) {
    throw new Error(`Conflict #${conflictIndex + 1} was not found; the file may have changed on disk.`);
  }
  let replacement: string;
  switch (choice) {
    case "local":
      replacement = target.local;
      break;
    case "base":
      replacement = target.base;
      break;
    case "upstream":
      replacement = target.upstream;
      break;
    case "custom":
      if (customText === undefined) throw new Error("A custom resolution requires replacement text.");
      replacement = customText !== "" && !customText.endsWith("\n") ? `${customText}\n` : customText;
      break;
  }
  const segments: FileSegment[] = model.segments.map((segment) =>
    segment === target ? { type: "text" as const, text: replacement } : segment,
  );
  return renderConflictFile({ segments, conflictCount: model.conflictCount - 1 });
}
