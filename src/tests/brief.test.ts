import { describe, expect, it } from "vitest";
import { briefTimestamp, renderBrief } from "../core/brief";
import type { Intent } from "../core/manifest";

const HASH = "e".repeat(64);

describe("briefTimestamp", () => {
  it("is filesystem-safe (no colons) and ISO-derived", () => {
    const ts = briefTimestamp(new Date("2026-07-02T13:57:00.123Z"));
    expect(ts).toBe("2026-07-02T13-57-00.123Z");
    expect(ts).not.toContain(":");
  });
});

describe("renderBrief", () => {
  const section = {
    url: "https://github.com/acme/widgets.git",
    remoteRef: "main",
    oldSha: "1".repeat(40),
    newSha: "2".repeat(40),
    conflicts: ["lib/theme.ts"],
    warnings: [{ path: "lib/logo.png", message: "binary file changed both locally and upstream" }],
    log: "2222222 rework theming\n1111111 fix typo",
  };
  const intents: Intent[] = [
    { id: "aa11bb22", date: "2026-06-01T00:00:00Z", description: "Brand palette replaces default tokens.", files: { "lib/theme.ts": HASH } },
    { id: "cc33dd44", date: "2026-06-02T00:00:00Z", description: "Unrelated tweak elsewhere.", files: { "other/file.ts": HASH } },
  ];

  it("lists conflicted files, warnings, and the upstream log", () => {
    const md = renderBrief([section], intents, new Date());
    expect(md).toContain("`lib/theme.ts`");
    expect(md).toContain("binary file changed both locally and upstream");
    expect(md).toContain("rework theming");
  });

  it("includes the full text of notes intersecting the conflicts, and only those", () => {
    const md = renderBrief([section], intents, new Date());
    expect(md).toContain("aa11bb22");
    expect(md).toContain("Brand palette replaces default tokens.");
    expect(md).not.toContain("Unrelated tweak elsewhere.");
  });

  it("instructs the fixer to rebuild notes, remove markers, and run resolve", () => {
    const md = renderBrief([section], intents, new Date());
    expect(md).toContain("Instructions for the person or agent fixing this");
    expect(md.toLowerCase()).toContain("rebuild");
    expect(md).toContain("Remove ALL conflict markers");
    expect(md).toContain("regraft resolve");
  });

  it("flags unrecorded changes when no note covers the conflicts", () => {
    const md = renderBrief([section], [], new Date());
    expect(md).toContain("UNRECORDED");
  });
});
