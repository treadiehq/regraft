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
const GRAFT_ID = "g_0123456789abcdef";

function sampleManifest(): Manifest {
  return {
    version: 2,
    grafts: [
      {
        id: GRAFT_ID,
        name: "lib",
        url: "https://github.com/acme/widgets.git",
        remoteRef: "main",
        path: "src/lib",
        dest: "lib",
        pinnedSha: SHA,
        ownership: "complete",
        excluded: [],
        files: {
          "z.ts": {
            upstreamHash: HASH,
            localHash: HASH,
            intentIds: [],
            needsIntent: false,
            pending: null,
          },
          "a.ts": {
            upstreamHash: HASH,
            localHash: HASH,
            intentIds: ["abcd1234"],
            needsIntent: false,
            pending: null,
          },
        },
      },
    ],
    intents: [
      {
        id: "abcd1234",
        date: "2026-01-02T03:04:05.000Z",
        description: "why",
        targets: [{ kind: "graft-file", graftId: GRAFT_ID, rel: "a.ts", path: "lib/a.ts", hash: HASH }],
      },
    ],
  };
}

describe("manifest load/save", () => {
  it("returns null when regraft.json is absent", () => {
    expect(loadManifest(makeTempDir())).toBeNull();
  });

  it("requireManifest throws a helpful error when absent", () => {
    expect(() => requireManifest(makeTempDir())).toThrow(/regraft add/);
  });

  it("round-trips v2 and sorts file keys for stable diffs", () => {
    const dir = makeTempDir();
    saveManifest(dir, sampleManifest());
    const loaded = loadManifest(dir)!;
    expect(Object.keys(loaded.grafts[0]!.files)).toEqual(["a.ts", "z.ts"]);
    expect(loaded.intents[0]!.description).toBe("why");
    expect(readFileSync(join(dir, "regraft.json"), "utf8").endsWith("\n")).toBe(true);
  });

  it("migrates version 1 safely in memory", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "regraft.json"),
      JSON.stringify({
        version: 1,
        sources: [
          {
            url: "https://github.com/acme/widgets.git",
            remoteRef: "main",
            path: "src/lib",
            dest: "lib",
            pinnedSha: SHA,
            files: { "a.ts": HASH },
            unresolved: [],
          },
        ],
        intents: [],
      }),
    );
    const migrated = loadManifest(dir)!;
    expect(migrated.version).toBe(2);
    expect(migrated.grafts[0]).toMatchObject({ name: "lib", dest: "lib" });
    expect(migrated.grafts[0]!.files["a.ts"]!.upstreamHash).toBe(HASH);
    expect(migrated.grafts[0]!.ownership).toBe("legacy-unknown");
  });

  it("canonicalizes safe v1 path aliases without collapsing collisions", () => {
    const aliasDir = makeTempDir();
    writeFileSync(
      join(aliasDir, "regraft.json"),
      JSON.stringify({
        version: 1,
        sources: [
          {
            url: "https://github.com/acme/widgets.git",
            remoteRef: "main",
            path: "./src/lib",
            dest: "./lib",
            pinnedSha: SHA,
            files: { "./a.ts": HASH },
            unresolved: [],
          },
        ],
        intents: [],
      }),
    );
    expect(loadManifest(aliasDir)!.grafts[0]).toMatchObject({
      path: "src/lib",
      dest: "lib",
      files: { "a.ts": expect.any(Object) },
    });

    const collisionDir = makeTempDir();
    writeFileSync(
      join(collisionDir, "regraft.json"),
      JSON.stringify({
        version: 1,
        sources: [
          {
            url: "https://github.com/acme/widgets.git",
            remoteRef: "main",
            path: "",
            dest: "lib",
            pinnedSha: SHA,
            files: { "folder/file.ts": HASH, "folder\\\\file.ts": HASH },
            unresolved: [],
          },
        ],
        intents: [],
      }),
    );
    expect(() => loadManifest(collisionDir)).toThrow(/collides with another path/);
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
    (bad.grafts as Record<string, unknown>[])[0]!.pinnedSha = "not-a-sha";
    writeFileSync(join(dir, "regraft.json"), JSON.stringify(bad));
    expect(() => loadManifest(dir)).toThrow(/pinnedSha/);
  });

  it("rejects project path traversal in manifest-controlled paths", () => {
    const cases: [string, (manifest: Manifest) => void][] = [
      ["grafts.0.dest", (manifest) => void (manifest.grafts[0]!.dest = "../outside")],
      [
        "grafts.0.files",
        (manifest) =>
          void (manifest.grafts[0]!.files = {
            "../outside.ts": {
              upstreamHash: HASH,
              localHash: HASH,
              intentIds: [],
              needsIntent: false,
              pending: null,
            },
          }),
      ],
      ["intents.0.targets", (manifest) => void (manifest.intents[0]!.targets[0]!.path = "../outside.ts")],
    ];

    for (const [path, mutate] of cases) {
      const dir = makeTempDir();
      const bad = sampleManifest();
      mutate(bad);
      writeFileSync(join(dir, "regraft.json"), JSON.stringify(bad));
      expect(() => loadManifest(dir), path).toThrow(/project-relative/);
    }
  });

  it("rejects noncanonical persisted paths before they can collapse file identity", () => {
    for (const badPath of ["folder\\\\file.ts", "folder/./file.ts", "folder//file.ts"]) {
      const dir = makeTempDir();
      const bad = sampleManifest();
      bad.grafts[0]!.files = {
        [badPath]: {
          upstreamHash: HASH,
          localHash: HASH,
          intentIds: [],
          needsIntent: false,
          pending: null,
        },
      };
      writeFileSync(join(dir, "regraft.json"), JSON.stringify(bad));
      expect(() => loadManifest(dir), badPath).toThrow(/canonical project-relative form/);
    }
  });

  it("rejects overlapping Graft destinations", () => {
    const dir = makeTempDir();
    const bad = sampleManifest();
    bad.grafts.push({ ...bad.grafts[0]!, id: "g_fedcba9876543210", name: "nested", dest: "lib/nested" });
    writeFileSync(join(dir, "regraft.json"), JSON.stringify(bad));
    expect(() => loadManifest(dir)).toThrow(/overlaps destination/);
  });

  it("rejects duplicate Intent IDs and mismatched active Intent references", () => {
    const duplicateDir = makeTempDir();
    const duplicate = sampleManifest();
    duplicate.intents.push({ ...duplicate.intents[0]!, targets: [...duplicate.intents[0]!.targets] });
    writeFileSync(join(duplicateDir, "regraft.json"), JSON.stringify(duplicate));
    expect(() => loadManifest(duplicateDir)).toThrow(/duplicate Intent ID/);

    const mismatchDir = makeTempDir();
    const mismatch = sampleManifest();
    mismatch.intents[0]!.targets[0] = {
      kind: "graft-file",
      graftId: GRAFT_ID,
      rel: "z.ts",
      path: "lib/z.ts",
      hash: HASH,
    };
    writeFileSync(join(mismatchDir, "regraft.json"), JSON.stringify(mismatch));
    expect(() => loadManifest(mismatchDir)).toThrow(/does not target this Graft file/);
  });

  it("rejects unknown manifest versions", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "regraft.json"), JSON.stringify({ version: 3, grafts: [], intents: [] }));
    expect(() => loadManifest(dir)).toThrow(/unsupported manifest version/);
  });

  it("emptyManifest validates against the schema", () => {
    const dir = makeTempDir();
    saveManifest(dir, emptyManifest());
    expect(loadManifest(dir)).toEqual({ version: 2, grafts: [], intents: [] });
  });
});
