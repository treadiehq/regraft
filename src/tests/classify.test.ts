import { describe, expect, it } from "vitest";
import { classifyFile, intentHashesByPath, intentHashesFor } from "../core/classify";
import type { Intent } from "../core/manifest";

const H = (c: string): string => c.repeat(64);

describe("classifyFile — the three-hash classification table", () => {
  const none = new Set<string>();

  it("disk == stored → clean", () => {
    expect(classifyFile({ storedHash: H("a"), diskHash: H("a"), unresolved: false, intentHashes: none })).toBe("clean");
  });

  it("disk missing → missing", () => {
    expect(classifyFile({ storedHash: H("a"), diskHash: null, unresolved: false, intentHashes: none })).toBe("missing");
  });

  it("disk != stored, disk matches an intent snapshot → modified+intent", () => {
    expect(
      classifyFile({ storedHash: H("a"), diskHash: H("b"), unresolved: false, intentHashes: new Set([H("b")]) }),
    ).toBe("modified+intent");
  });

  it("disk != stored, no intent snapshot matches → modified-unrecorded", () => {
    expect(
      classifyFile({ storedHash: H("a"), diskHash: H("b"), unresolved: false, intentHashes: new Set([H("c")]) }),
    ).toBe("modified-unrecorded");
  });

  it("unresolved wins over everything, even clean-looking or missing files", () => {
    expect(classifyFile({ storedHash: H("a"), diskHash: H("a"), unresolved: true, intentHashes: none })).toBe(
      "conflict-unresolved",
    );
    expect(classifyFile({ storedHash: H("a"), diskHash: null, unresolved: true, intentHashes: none })).toBe(
      "conflict-unresolved",
    );
  });

  it("a stale intent snapshot (different hash) does not count as coverage", () => {
    expect(
      classifyFile({ storedHash: H("a"), diskHash: H("d"), unresolved: false, intentHashes: new Set([H("b")]) }),
    ).toBe("modified-unrecorded");
  });
});

describe("intentHashesByPath", () => {
  it("collects every snapshot hash per path across intents", () => {
    const intents: Intent[] = [
      { id: "one", date: "2026-01-01T00:00:00Z", description: "first", files: { "lib/a.ts": H("1") } },
      { id: "two", date: "2026-02-01T00:00:00Z", description: "second", files: { "lib/a.ts": H("2"), "lib/b.ts": H("3") } },
    ];
    const map = intentHashesByPath(intents);
    expect(intentHashesFor(map, "lib/a.ts")).toEqual(new Set([H("1"), H("2")]));
    expect(intentHashesFor(map, "lib/b.ts")).toEqual(new Set([H("3")]));
    expect(intentHashesFor(map, "lib/none.ts").size).toBe(0);
  });
});
