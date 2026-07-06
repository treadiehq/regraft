import { describe, expect, it } from "vitest";
import { hasConflictMarkers, mergeThreeWay } from "../core/merge";

const buf = (s: string): Buffer => Buffer.from(s);

describe("mergeThreeWay", () => {
  it("merges non-overlapping changes silently", () => {
    const base = buf("line1\nline2\nline3\nline4\nline5\n");
    const ours = buf("LOCAL1\nline2\nline3\nline4\nline5\n");
    const theirs = buf("line1\nline2\nline3\nline4\nUPSTREAM5\n");
    const result = mergeThreeWay({ base, ours, theirs });
    expect(result.conflicted).toBe(false);
    expect(result.content.toString()).toBe("LOCAL1\nline2\nline3\nline4\nUPSTREAM5\n");
  });

  it("produces inline diff3 markers on true conflicts", () => {
    const base = buf("a\nshared\nz\n");
    const ours = buf("a\nlocal version\nz\n");
    const theirs = buf("a\nupstream version\nz\n");
    const result = mergeThreeWay({ base, ours, theirs });
    expect(result.conflicted).toBe(true);
    const text = result.content.toString();
    expect(text).toContain("<<<<<<< local");
    expect(text).toContain("||||||| base");
    expect(text).toContain(">>>>>>> upstream");
    expect(text).toContain("local version");
    expect(text).toContain("upstream version");
    expect(text).toContain("shared"); // diff3 style keeps the base hunk inline
    // markers are inline, not a whole-file diff at the top
    expect(text.startsWith("a\n")).toBe(true);
  });

  it("takes upstream cleanly when only upstream changed", () => {
    const base = buf("one\ntwo\n");
    const result = mergeThreeWay({ base, ours: base, theirs: buf("one\ntwo\nthree\n") });
    expect(result.conflicted).toBe(false);
    expect(result.content.toString()).toBe("one\ntwo\nthree\n");
  });
});

describe("hasConflictMarkers", () => {
  it("detects <<<<<<< / ||||||| / >>>>>>> at line starts", () => {
    expect(hasConflictMarkers("x\n<<<<<<< local\ny\n")).toBe(true);
    expect(hasConflictMarkers("x\n||||||| base\ny\n")).toBe(true);
    expect(hasConflictMarkers("x\n>>>>>>> upstream\ny\n")).toBe(true);
  });

  it("detects git markers with empty labels", () => {
    expect(hasConflictMarkers("x\n<<<<<<< \ny\n")).toBe(true);
    expect(hasConflictMarkers("x\n||||||| \ny\n")).toBe(true);
    expect(hasConflictMarkers("x\n>>>>>>> \ny\n")).toBe(true);
  });

  it("does not fire on bare marker sequences", () => {
    expect(hasConflictMarkers("x\n<<<<<<<\ny\n")).toBe(false);
    expect(hasConflictMarkers("x\n|||||||\ny\n")).toBe(false);
    expect(hasConflictMarkers("x\n>>>>>>>\ny\n")).toBe(false);
    expect(hasConflictMarkers("x\n<<<<<<<")).toBe(false);
  });

  it("does not fire on ======= alone (setext headings, dividers)", () => {
    expect(hasConflictMarkers("Title\n=======\nbody\n")).toBe(false);
  });

  it("does not fire on shorter or indented runs", () => {
    expect(hasConflictMarkers("a << b\n  <<<<<<< indented\n")).toBe(false);
    expect(hasConflictMarkers("<<< short\n")).toBe(false);
  });
});
