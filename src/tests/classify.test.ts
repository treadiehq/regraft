import { describe, expect, it } from "vitest";
import { classifyFile, intentHashesByPath, intentHashesFor } from "../core/classify";
import type { Intent } from "../core/manifest";

const H = (character: string): string => character.repeat(64);

describe("classifyFile — Graft state classification", () => {
  const base = {
    upstreamHash: H("a"),
    localHash: H("a"),
    diskHash: H("a"),
    pending: null,
    intentIds: [] as string[],
    needsIntent: false,
  };

  it("disk == local == upstream → clean", () => {
    expect(classifyFile(base)).toBe("clean");
  });

  it("missing accepted local content → missing", () => {
    expect(classifyFile({ ...base, diskHash: null })).toBe("missing");
  });

  it("accepted local derivation with Intent → modified+intent", () => {
    expect(
      classifyFile({
        ...base,
        localHash: H("b"),
        diskHash: H("b"),
        intentIds: ["intent"],
      }),
    ).toBe("modified+intent");
  });

  it("new disk content or missing Intent → modified-unrecorded", () => {
    expect(classifyFile({ ...base, diskHash: H("b") })).toBe("modified-unrecorded");
    expect(classifyFile({ ...base, localHash: H("b"), diskHash: H("b") })).toBe("modified-unrecorded");
  });

  it("pending text conflict wins over disk state", () => {
    expect(
      classifyFile({
        ...base,
        pending: {
          kind: "content-conflict",
          fromSha: "a".repeat(40),
          toSha: "b".repeat(40),
          targetKnown: true,
          targetHash: H("c"),
          observedLocalHash: H("b"),
          markerHash: H("d"),
          brief: null,
        },
      }),
    ).toBe("conflict-unresolved");
  });

  it("other pending judgment has its own status", () => {
    expect(
      classifyFile({
        ...base,
        pending: {
          kind: "binary-conflict",
          fromSha: "a".repeat(40),
          toSha: "b".repeat(40),
          targetKnown: true,
          targetHash: H("c"),
          observedLocalHash: H("b"),
          markerHash: null,
          brief: null,
        },
      }),
    ).toBe("reconciliation-pending");
  });
});

describe("intentHashesByPath", () => {
  it("collects every historical snapshot hash per path", () => {
    const intents: Intent[] = [
      {
        id: "one",
        date: "2026-01-01T00:00:00Z",
        description: "first",
        targets: [{ kind: "legacy-orphan", path: "lib/a.ts", hash: H("1") }],
      },
      {
        id: "two",
        date: "2026-02-01T00:00:00Z",
        description: "second",
        targets: [
          { kind: "legacy-orphan", path: "lib/a.ts", hash: H("2") },
          { kind: "legacy-orphan", path: "lib/b.ts", hash: H("3") },
        ],
      },
    ];
    const map = intentHashesByPath(intents);
    expect(intentHashesFor(map, "lib/a.ts")).toEqual(new Set([H("1"), H("2")]));
    expect(intentHashesFor(map, "lib/b.ts")).toEqual(new Set([H("3")]));
    expect(intentHashesFor(map, "lib/none.ts").size).toBe(0);
  });
});
