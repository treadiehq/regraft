import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  emptyManifest,
  loadManifest,
  requireManifest,
  saveManifest,
  type Manifest,
} from "../core/manifest";
import { cleanupTempDirs, makeTempDir } from "./helpers";

afterAll(cleanupTempDirs);

const SHA = "a".repeat(40);
const HASH = "b".repeat(64);

function sampleManifest(): Manifest {
  return {
    version: 1,
    sources: [
      {
        url: "https://github.com/acme/widgets.git",
        remoteRef: "main",
        path: "src/lib",
        dest: "lib",
        pinnedSha: SHA,
        files: { "z.ts": HASH, "a.ts": HASH },
        unresolved: ["z.ts"],
      },
    ],
    intents: [{ id: "abcd1234", date: "2026-01-02T03:04:05.000Z", description: "why", files: { "lib/a.ts": HASH } }],
  };
}

describe("manifest load/save", () => {
  it("returns null when regraft.json is absent", () => {
    expect(loadManifest(makeTempDir())).toBeNull();
  });

  it("requireManifest throws a helpful error when absent", () => {
    expect(() => requireManifest(makeTempDir())).toThrow(/regraft add/);
  });

  it("round-trips and sorts file keys for stable diffs", () => {
    const dir = makeTempDir();
    saveManifest(dir, sampleManifest());
    const loaded = loadManifest(dir);
    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded!.sources[0]!.files)).toEqual(["a.ts", "z.ts"]);
    expect(loaded!.intents[0]!.description).toBe("why");
    expect(readFileSync(join(dir, "regraft.json"), "utf8").endsWith("\n")).toBe(true);
  });

  it("rejects invalid JSON with a clear error", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "regraft.json"), "{ not json");
    expect(() => loadManifest(dir)).toThrow(/not valid JSON/);
  });

  it.skipIf(process.platform === "win32")("refuses a symlinked manifest", () => {
    const dir = makeTempDir();
    const target = join(dir, "outside.json");
    const original = JSON.stringify(emptyManifest());
    writeFileSync(target, original);
    symlinkSync("outside.json", join(dir, "regraft.json"));

    expect(() => loadManifest(dir)).toThrow(/symbolic link/);
    expect(() => saveManifest(dir, sampleManifest())).toThrow(/symbolic link/);
    expect(readFileSync(target, "utf8")).toBe(original);
  });

  it("rejects schema violations, naming the offending path", () => {
    const dir = makeTempDir();
    const bad = sampleManifest() as unknown as Record<string, unknown>;
    (bad.sources as Record<string, unknown>[])[0]!.pinnedSha = "not-a-sha";
    writeFileSync(join(dir, "regraft.json"), JSON.stringify(bad));
    expect(() => loadManifest(dir)).toThrow(/pinnedSha/);
  });

  it("rejects project path traversal in manifest-controlled paths", () => {
    const cases: [string, (manifest: Manifest) => void][] = [
      ["sources.0.dest", (manifest) => void (manifest.sources[0]!.dest = "../outside")],
      ["sources.0.files", (manifest) => void (manifest.sources[0]!.files = { "../outside.ts": HASH })],
      ["sources.0.unresolved", (manifest) => void (manifest.sources[0]!.unresolved = ["../outside.ts"])],
      ["intents.0.files", (manifest) => void (manifest.intents[0]!.files = { "../outside.ts": HASH })],
    ];

    for (const [path, mutate] of cases) {
      const dir = makeTempDir();
      const bad = sampleManifest();
      mutate(bad);
      writeFileSync(join(dir, "regraft.json"), JSON.stringify(bad));
      expect(() => loadManifest(dir), path).toThrow(/project-relative/);
    }
  });

  it("rejects unknown manifest versions", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "regraft.json"), JSON.stringify({ version: 2, sources: [], intents: [] }));
    expect(() => loadManifest(dir)).toThrow(/version/);
  });

  it("emptyManifest validates against the schema", () => {
    const dir = makeTempDir();
    saveManifest(dir, emptyManifest());
    expect(loadManifest(dir)).toEqual({ version: 1, sources: [], intents: [] });
  });
});
