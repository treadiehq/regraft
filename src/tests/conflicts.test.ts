import { describe, expect, it } from "vitest";
import {
  applyConflictChoice,
  parseConflictFile,
  reconstructLocal,
  renderConflictFile,
  type ConflictChoice,
} from "../core/conflicts";
import { mergeThreeWay } from "../core/merge";

const MARKED = [
  "line1",
  "<<<<<<< local",
  "mine A",
  "mine B",
  "||||||| base",
  "old",
  "=======",
  "theirs",
  ">>>>>>> upstream",
  "middle",
  "<<<<<<< local",
  "mine 2",
  "||||||| base",
  "=======",
  "theirs 2a",
  "theirs 2b",
  ">>>>>>> upstream",
  "tail",
  "",
].join("\n");

const EMBEDDED_LOCAL_MARKER = [
  "line1",
  "<<<<<<< local",
  "<<<<<<< EMBEDDED MARKER IN LOCAL",
  "||||||| base",
  "some content",
  "=======",
  "MODIFIED UPSTREAM",
  ">>>>>>> upstream",
  "line3",
  "",
].join("\n");

describe("parseConflictFile", () => {
  it("finds every conflict with its three sides", () => {
    const model = parseConflictFile(MARKED);
    expect(model.conflictCount).toBe(2);
    const conflicts = model.segments.filter((segment) => segment.type === "conflict");
    expect(conflicts[0]).toMatchObject({ local: "mine A\nmine B\n", base: "old\n", upstream: "theirs\n" });
    expect(conflicts[1]).toMatchObject({ local: "mine 2\n", base: "", upstream: "theirs 2a\ntheirs 2b\n" });
  });

  it("round-trips byte-for-byte", () => {
    expect(renderConflictFile(parseConflictFile(MARKED))).toBe(MARKED);
  });

  it("round-trips a file without trailing newline", () => {
    const text = "a\n<<<<<<< local\nx\n||||||| base\n=======\ny\n>>>>>>> upstream\nlast line no newline";
    expect(renderConflictFile(parseConflictFile(text))).toBe(text);
    expect(parseConflictFile(text).conflictCount).toBe(1);
  });

  it("treats malformed marker runs as plain text", () => {
    const text = "start\n<<<<<<< local\norphaned\nno divider or end\n";
    const model = parseConflictFile(text);
    expect(model.conflictCount).toBe(0);
    expect(renderConflictFile(model)).toBe(text);
  });

  it("parses real git merge-file --diff3 output", () => {
    const base = "one\ntwo\nthree\nfour\nfive\n";
    const merged = mergeThreeWay({
      base: Buffer.from(base),
      ours: Buffer.from(base.replace("three", "OURS")),
      theirs: Buffer.from(base.replace("three", "THEIRS")),
    });
    expect(merged.conflicted).toBe(true);
    const model = parseConflictFile(merged.content.toString("utf8"));
    expect(model.conflictCount).toBe(1);
    const conflict = model.segments.find((segment) => segment.type === "conflict")!;
    expect(conflict).toMatchObject({ local: "OURS\n", base: "three\n", upstream: "THEIRS\n" });
    expect(renderConflictFile(model)).toBe(merged.content.toString("utf8"));
  });

  it("keeps embedded marker-like lines in their conflict sections", () => {
    const text = [
      "<<<<<<< local",
      "<<<<<<< embedded local start",
      ">>>>>>> embedded local end",
      "||||||| base",
      "<<<<<<< embedded base start",
      "||||||| embedded base marker",
      ">>>>>>> embedded base end",
      "=======",
      "<<<<<<< embedded upstream start",
      "||||||| embedded upstream base",
      "=======",
      "upstream content",
      ">>>>>>> upstream",
      "",
    ].join("\n");
    const model = parseConflictFile(text);
    const conflict = model.segments.find((segment) => segment.type === "conflict");

    expect(model.conflictCount).toBe(1);
    expect(conflict).toMatchObject({
      local: "<<<<<<< embedded local start\n>>>>>>> embedded local end\n",
      base: "<<<<<<< embedded base start\n||||||| embedded base marker\n>>>>>>> embedded base end\n",
      upstream: "<<<<<<< embedded upstream start\n||||||| embedded upstream base\n=======\nupstream content\n",
      markers: { start: "<<<<<<< local\n", base: "||||||| base\n", end: ">>>>>>> upstream\n" },
    });
    expect(renderConflictFile(model)).toBe(text);
  });

  it("still preserves a malformed conflict with no end marker as plain text", () => {
    const text = [
      "before",
      "<<<<<<< local",
      "mine",
      "||||||| base",
      "old",
      "=======",
      "theirs",
      "after",
      "",
    ].join("\n");
    const model = parseConflictFile(text);

    expect(model.conflictCount).toBe(0);
    expect(renderConflictFile(model)).toBe(text);
  });
});

describe("reconstructLocal", () => {
  it("collapses every conflict to the local side", () => {
    expect(reconstructLocal(MARKED)).toBe("line1\nmine A\nmine B\nmiddle\nmine 2\ntail\n");
  });
});

describe("applyConflictChoice", () => {
  it("preserves embedded local markers when choosing the local side", () => {
    expect(applyConflictChoice(EMBEDDED_LOCAL_MARKER, 0, "local")).toBe(
      "line1\n<<<<<<< EMBEDDED MARKER IN LOCAL\nline3\n",
    );
  });

  it("replaces one region and leaves the other untouched", () => {
    const next = applyConflictChoice(MARKED, 0, "upstream");
    expect(next).toContain("line1\ntheirs\nmiddle");
    expect(next).toContain("<<<<<<< local\nmine 2");
    expect(parseConflictFile(next).conflictCount).toBe(1);
  });

  it("resolves regions by index even after earlier ones are gone", () => {
    const afterFirst = applyConflictChoice(MARKED, 0, "local");
    // The remaining conflict is re-indexed to 0 on the next parse.
    const afterBoth = applyConflictChoice(afterFirst, 0, "custom", "hand-written\n");
    expect(parseConflictFile(afterBoth).conflictCount).toBe(0);
    expect(afterBoth).toBe("line1\nmine A\nmine B\nmiddle\nhand-written\ntail\n");
  });

  it("appends a newline to custom text when missing", () => {
    const next = applyConflictChoice(MARKED, 0, "custom", "no newline");
    expect(next).toContain("line1\nno newline\nmiddle\n");
  });

  it("allows an empty custom resolution to drop the region", () => {
    const next = applyConflictChoice(MARKED, 1, "custom", "");
    expect(next).toContain("middle\ntail\n");
  });

  it("rejects unknown conflict indexes", () => {
    expect(() => applyConflictChoice(MARKED, 5, "local")).toThrow(/was not found/);
  });

  it("rejects invalid runtime choices instead of deleting conflict content", () => {
    expect(() => applyConflictChoice(MARKED, 0, "invalid" as ConflictChoice)).toThrow(
      /Invalid conflict choice/,
    );
  });
});
