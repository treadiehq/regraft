import { describe, expect, it } from "vitest";
import { applyConflictChoice, parseConflictFile } from "../core/conflicts";
import { mergeThreeWay } from "../core/merge";
import { analyzeResolution, reopenRegion } from "../core/review";

const BASE = "a\nb\nc\nd\ne\nf\ng\nh\n";
const LOCAL = BASE.replace("c", "C-local").replace("g", "G-local");
const UPSTREAM = BASE.replace("c", "C-up").replace("g", "G-up");

function mergedMarkers(): string {
  const merged = mergeThreeWay({
    base: Buffer.from(BASE),
    ours: Buffer.from(LOCAL),
    theirs: Buffer.from(UPSTREAM),
  });
  expect(merged.conflicted).toBe(true);
  return merged.content.toString("utf8");
}

function analyze(working: string) {
  const analysis = analyzeResolution({ base: BASE, local: LOCAL, upstream: UPSTREAM, working });
  expect(analysis).not.toBeNull();
  return analysis!;
}

describe("analyzeResolution", () => {
  it("reports every region as unresolved on the fresh merge output", () => {
    const analysis = analyze(mergedMarkers());
    expect(analysis.regions).toHaveLength(2);
    expect(analysis.unresolved).toBe(2);
    expect(analysis.regions.map((region) => region.status)).toEqual(["unresolved", "unresolved"]);
    expect(analysis.regions[0]!.local).toBe("C-local\n");
    expect(analysis.regions[0]!.upstream).toBe("C-up\n");
    expect(analysis.regions[1]!.base).toBe("g\n");
  });

  it("classifies chosen sides after partial resolution", () => {
    const partiallyResolved = applyConflictChoice(mergedMarkers(), 0, "upstream");
    const analysis = analyze(partiallyResolved);
    expect(analysis.regions.map((region) => region.status)).toEqual(["upstream", "unresolved"]);
    expect(analysis.regions[0]!.text).toBe("C-up\n");
    expect(analysis.unresolved).toBe(1);
  });

  it("classifies local, base, and custom resolutions", () => {
    // applyConflictChoice re-indexes remaining markers, so the second region becomes 0.
    let working = applyConflictChoice(mergedMarkers(), 0, "local");
    working = applyConflictChoice(working, 0, "custom", "G-combined\n");
    const analysis = analyze(working);
    expect(analysis.regions.map((region) => region.status)).toEqual(["local", "custom"]);

    const reverted = applyConflictChoice(mergedMarkers(), 0, "base");
    expect(analyze(applyConflictChoice(reverted, 0, "upstream")).regions[0]!.status).toBe("base");
  });

  it("analyzes a file that was fully resolved outside the UI", () => {
    // Simulate an agent editing the working file directly: no markers left.
    const byAgent = BASE.replace("c", "C-up").replace("g", "G-combined");
    const analysis = analyze(byAgent);
    expect(analysis.unresolved).toBe(0);
    expect(analysis.regions.map((region) => region.status)).toEqual(["upstream", "custom"]);
    expect(analysis.regions[1]!.text).toBe("G-combined\n");
  });

  it("returns null when stable text was edited and alignment fails", () => {
    const working = mergedMarkers().replace("f\n", "f edited\n");
    expect(analyzeResolution({ base: BASE, local: LOCAL, upstream: UPSTREAM, working })).toBeNull();
  });

  it("returns null when there is nothing to review", () => {
    expect(analyzeResolution({ base: BASE, local: BASE, upstream: UPSTREAM, working: UPSTREAM })).toBeNull();
  });
});

describe("reopenRegion", () => {
  it("restores the diff3 markers for one decided region", () => {
    const resolved = applyConflictChoice(applyConflictChoice(mergedMarkers(), 0, "upstream"), 0, "local");
    // both regions decided: region 0 upstream, region 1 local (indexes shift after each choice)
    expect(parseConflictFile(resolved).conflictCount).toBe(0);

    const reopened = reopenRegion(resolved, analyze(resolved), 0);
    expect(parseConflictFile(reopened).conflictCount).toBe(1);
    const analysis = analyze(reopened);
    expect(analysis.regions.map((region) => region.status)).toEqual(["unresolved", "local"]);
    expect(analysis.regions[0]!.local).toBe("C-local\n");
    expect(analysis.regions[0]!.upstream).toBe("C-up\n");
  });

  it("refuses to reopen a region that is still open", () => {
    const working = mergedMarkers();
    expect(() => reopenRegion(working, analyze(working), 0)).toThrow(/already open/);
  });
});
