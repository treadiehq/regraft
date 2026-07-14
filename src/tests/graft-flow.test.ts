import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addCommand } from "../commands/add";
import { inspectCommand } from "../commands/inspect";
import { noteCommand } from "../commands/note";
import { pullCommand } from "../commands/pull";
import { resolveCommand } from "../commands/resolve";
import { statusCommand } from "../commands/status";
import { sha256 } from "../core/hash";
import { loadManifest, saveManifest } from "../core/manifest";
import { cleanupTempDirs, commitUpstream, initUpstream, makeProject, writeFiles } from "./helpers";

afterAll(cleanupTempDirs);

const BASE = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n";

describe("Graft identity and selection", () => {
  it("creates stable names and permits one Source at disjoint destinations", () => {
    const upstream = initUpstream({ "lib/a.ts": "a\n" });
    const project = makeProject();
    const first = addCommand(`${upstream.url}#main:lib`, "vendor/one", { cwd: project, name: "one" });
    const second = addCommand(`${upstream.url}#main:lib`, "vendor/two", { cwd: project, name: "two" });
    expect(first.source.id).not.toBe(second.source.id);
    expect(loadManifest(project)!.grafts.map((graft) => graft.name)).toEqual(["one", "two"]);
  });

  it("rejects equal, nested, and case-only destination ownership", () => {
    const first = initUpstream({ "lib/a.ts": "a\n" });
    const second = initUpstream({ "lib/b.ts": "b\n" });
    const project = makeProject();
    addCommand(`${first.url}#main:lib`, "Vendor/Auth", { cwd: project, name: "auth" });
    expect(() =>
      addCommand(`${second.url}#main:lib`, "vendor/auth/nested", { cwd: project, name: "nested" }),
    ).toThrow(/overlaps Graft "auth"/);
  });

  it("pulls only selected Grafts by exact name", () => {
    const auth = initUpstream({ "lib/auth.ts": "auth v1\n" });
    const ui = initUpstream({ "lib/ui.ts": "ui v1\n" });
    const project = makeProject();
    addCommand(`${auth.url}#main:lib`, "src/auth", { cwd: project, name: "auth" });
    addCommand(`${ui.url}#main:lib`, "src/ui", { cwd: project, name: "ui" });
    commitUpstream(auth, { "lib/auth.ts": "auth v2\n" });
    commitUpstream(ui, { "lib/ui.ts": "ui v2\n" });

    const result = pullCommand({ cwd: project, grafts: ["auth"] });
    expect(result.sources.map((source) => source.name)).toEqual(["auth"]);
    expect(readFileSync(join(project, "src/auth/auth.ts"), "utf8")).toBe("auth v2\n");
    expect(readFileSync(join(project, "src/ui/ui.ts"), "utf8")).toBe("ui v1\n");
  });

  it("inspects the concrete files in an available upstream Update", () => {
    const upstream = initUpstream({ "lib/a.ts": "a v1\n" });
    const project = makeProject();
    addCommand(`${upstream.url}#main:lib`, "vendor", { cwd: project, name: "lib" });
    commitUpstream(upstream, { "lib/a.ts": "a v2\n", "lib/new.ts": "new\n" });
    const result = inspectCommand({ cwd: project, grafts: ["lib"] });
    expect(result.grafts[0]!.upstream).toMatchObject({
      checked: true,
      updateAvailable: true,
      changedFiles: [
        { path: "vendor/a.ts", change: "modified", binary: false },
        { path: "vendor/new.ts", change: "added", binary: false },
      ],
    });
  });

  it("never claims a file omitted by an earlier partial add", () => {
    const upstream = initUpstream({ "lib/a.ts": "a v1\n", "lib/skipped.ts": "local owner\n" });
    const project = makeProject();
    addCommand(`${upstream.url}#main:lib`, "vendor", { cwd: project, name: "lib" });
    const manifest = loadManifest(project)!;
    delete manifest.grafts[0]!.files["skipped.ts"];
    saveManifest(project, manifest);
    commitUpstream(upstream, { "lib/a.ts": "a v2\n", "lib/skipped.ts": "upstream v2\n" });

    const result = pullCommand({ cwd: project });
    expect(result.sources[0]!.skipped).toContainEqual({
      path: "vendor/skipped.ts",
      reason: "not tracked because it was skipped when the Graft was created",
    });
    expect(readFileSync(join(project, "vendor/skipped.ts"), "utf8")).toBe("local owner\n");
    expect(loadManifest(project)!.grafts[0]!.files["skipped.ts"]).toBeUndefined();
    expect(loadManifest(project)!.grafts[0]!.excluded).toEqual(["skipped.ts"]);

    commitUpstream(upstream, { "lib/a.ts": "a v3\n" }, { remove: ["lib/skipped.ts"] });
    pullCommand({ cwd: project });
    commitUpstream(upstream, { "lib/a.ts": "a v4\n", "lib/skipped.ts": "upstream reintroduced\n" });
    pullCommand({ cwd: project });
    expect(readFileSync(join(project, "vendor/skipped.ts"), "utf8")).toBe("local owner\n");
    expect(loadManifest(project)!.grafts[0]!.files["skipped.ts"]).toBeUndefined();
    expect(loadManifest(project)!.grafts[0]!.excluded).toEqual(["skipped.ts"]);
  });

  it("requires explicit judgment for new paths after an ambiguous v1 ownership migration", () => {
    const upstream = initUpstream({ "lib/a.ts": "a v1\n" });
    const project = makeProject();
    writeFiles(project, { "vendor/a.ts": "a v1\n" });
    writeFileSync(
      join(project, "regraft.json"),
      JSON.stringify({
        version: 1,
        sources: [
          {
            url: upstream.url,
            remoteRef: "main",
            path: "lib",
            dest: "vendor",
            pinnedSha: upstream.sha,
            files: { "a.ts": sha256("a v1\n") },
            unresolved: [],
          },
        ],
        intents: [],
      }),
    );
    commitUpstream(upstream, { "lib/a.ts": "a v2\n", "lib/possibly-skipped.ts": "upstream\n" });

    const result = pullCommand({ cwd: project });
    expect(result.exitCode).toBe(1);
    expect(existsSync(join(project, "vendor/possibly-skipped.ts"))).toBe(false);
    expect(loadManifest(project)!.grafts[0]!.files["possibly-skipped.ts"]!.pending?.kind).toBe(
      "ownership-unknown",
    );

    expect(pullCommand({ cwd: project, force: true }).exitCode).toBe(0);
    expect(readFileSync(join(project, "vendor/possibly-skipped.ts"), "utf8")).toBe("upstream\n");
  });
});

describe("durable repeated Updates", () => {
  it("preserves an intentional adaptation across consecutive clean merges", () => {
    const upstream = initUpstream({ "lib/file.txt": BASE });
    const project = makeProject();
    addCommand(`${upstream.url}#main:lib`, "vendor", { cwd: project, name: "auth" });
    writeFiles(project, { "vendor/file.txt": BASE.replace("line1", "LOCAL line1") });
    noteCommand("Keep our local line-one behavior", { cwd: project });

    commitUpstream(upstream, { "lib/file.txt": BASE.replace("line8", "UPSTREAM v2 line8") });
    expect(pullCommand({ cwd: project }).exitCode).toBe(0);

    const v2 = BASE.replace("line8", "UPSTREAM v2 line8");
    commitUpstream(upstream, { "lib/file.txt": v2.replace("line7", "UPSTREAM v3 line7") });
    expect(pullCommand({ cwd: project }).exitCode).toBe(0);

    const content = readFileSync(join(project, "vendor/file.txt"), "utf8");
    expect(content).toContain("LOCAL line1");
    expect(content).toContain("UPSTREAM v2 line8");
    expect(content).toContain("UPSTREAM v3 line7");
    expect(statusCommand({ cwd: project, offline: true }).sources[0]!.files[0]!.status).toBe("modified+intent");
  });

  it("preserves a conflict resolution across the following Update", () => {
    const upstream = initUpstream({ "lib/file.txt": BASE });
    const project = makeProject();
    addCommand(`${upstream.url}#main:lib`, "vendor", { cwd: project, name: "auth" });
    writeFiles(project, { "vendor/file.txt": BASE.replace("line4", "LOCAL resolved line4") });
    noteCommand("Retain our line-four policy", { cwd: project });
    commitUpstream(upstream, { "lib/file.txt": BASE.replace("line4", "UPSTREAM line4") });
    pullCommand({ cwd: project });

    const resolved = BASE.replace("line4", "LOCAL resolved on upstream v2 line4");
    writeFiles(project, { "vendor/file.txt": resolved });
    expect(resolveCommand({ cwd: project, note: "Reconciled our policy with upstream v2" }).exitCode).toBe(0);

    const upstreamV2 = BASE.replace("line4", "UPSTREAM line4");
    commitUpstream(upstream, { "lib/file.txt": upstreamV2.replace("line8", "UPSTREAM v3 line8") });
    expect(pullCommand({ cwd: project }).exitCode).toBe(0);
    const content = readFileSync(join(project, "vendor/file.txt"), "utf8");
    expect(content).toContain("LOCAL resolved on upstream v2 line4");
    expect(content).toContain("UPSTREAM v3 line8");
  });

  it("keeps binary judgment retryable at the same upstream revision", () => {
    const upstream = initUpstream({ "lib/logo.bin": Buffer.from([0, 1]) });
    const project = makeProject();
    addCommand(`${upstream.url}#main:lib`, "vendor", { cwd: project, name: "assets" });
    writeFiles(project, { "vendor/logo.bin": Buffer.from([0, 2]) });
    commitUpstream(upstream, { "lib/logo.bin": Buffer.from([0, 3]) });

    const first = pullCommand({ cwd: project });
    expect(first.exitCode).toBe(1);
    expect(loadManifest(project)!.grafts[0]!.files["logo.bin"]!.pending?.kind).toBe("binary-conflict");

    const retry = pullCommand({ cwd: project, force: true });
    expect(retry.exitCode).toBe(0);
    expect(readFileSync(join(project, "vendor/logo.bin"))).toEqual(Buffer.from([0, 3]));
    expect(loadManifest(project)!.grafts[0]!.files["logo.bin"]!.pending).toBeNull();
  });

  it("preserves active Intent when upstream reintroduces a locally retained file", () => {
    const upstream = initUpstream({ "lib/legacy.txt": "upstream v1\n" });
    const project = makeProject();
    addCommand(`${upstream.url}#main:lib`, "vendor", { cwd: project, name: "legacy" });
    writeFiles(project, { "vendor/legacy.txt": "required local implementation\n" });
    noteCommand("Keep the legacy compatibility implementation", { cwd: project });
    commitUpstream(upstream, {}, { remove: ["lib/legacy.txt"], message: "remove legacy implementation" });
    pullCommand({ cwd: project });
    resolveCommand({ cwd: project, note: "Retained compatibility after upstream removed the file" });

    commitUpstream(upstream, { "lib/legacy.txt": "new upstream implementation\n" });
    const result = pullCommand({ cwd: project });
    expect(result.exitCode).toBe(1);
    const file = loadManifest(project)!.grafts[0]!.files["legacy.txt"]!;
    expect(file.pending?.kind).toBe("destination-collision");
    expect(file.intentIds.length).toBeGreaterThan(0);
    expect(inspectCommand({ cwd: project, offline: true }).grafts[0]!.intent.length).toBeGreaterThan(0);
  });

  it("hydrates a v1 unresolved target from Git before a force retry", () => {
    const upstream = initUpstream({ "lib/file.txt": BASE });
    const oldSha = upstream.sha;
    const target = BASE.replace("line4", "UPSTREAM line4");
    const targetSha = commitUpstream(upstream, { "lib/file.txt": target });
    const project = makeProject();
    writeFiles(project, { "vendor/file.txt": "<<<<<<< local\nlocal\n=======\nupstream\n>>>>>>> upstream\n" });
    writeFileSync(
      join(project, "regraft.json"),
      JSON.stringify({
        version: 1,
        sources: [
          {
            url: upstream.url,
            remoteRef: "main",
            path: "lib",
            dest: "vendor",
            pinnedSha: targetSha,
            files: { "file.txt": "0".repeat(64) },
            unresolved: ["file.txt"],
          },
        ],
        intents: [],
      }),
    );
    expect(loadManifest(project)!.grafts[0]!.files["file.txt"]!.pending).toMatchObject({
      targetKnown: false,
      targetHash: null,
    });

    const result = pullCommand({ cwd: project, force: true });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(project, "vendor/file.txt"), "utf8")).toBe(target);
    const file = loadManifest(project)!.grafts[0]!.files["file.txt"]!;
    expect(file.upstreamHash).toBe(file.localHash);
    expect(file.pending).toBeNull();
    expect(oldSha).not.toBe(targetSha);
  });
});

describe("agent-readable inspection", () => {
  it("returns provenance, Intent, upstream status, and pending Brief context", () => {
    const upstream = initUpstream({ "lib/file.txt": BASE });
    const project = makeProject();
    addCommand(`${upstream.url}#main:lib`, "vendor", { cwd: project, name: "auth" });
    writeFiles(project, { "vendor/file.txt": BASE.replace("line4", "LOCAL line4") });
    noteCommand("Use our policy on line four", { cwd: project });
    commitUpstream(upstream, { "lib/file.txt": BASE.replace("line4", "UPSTREAM line4") });
    pullCommand({ cwd: project });

    const result = inspectCommand({ cwd: project, grafts: ["auth"], offline: true });
    expect(result).toMatchObject({ command: "inspect", schemaVersion: 1, exitCode: 1, offline: true });
    expect(result.grafts[0]).toMatchObject({
      name: "auth",
      source: { repository: upstream.url, path: "lib" },
      destination: "vendor",
      updates: { pending: [{ path: "vendor/file.txt", kind: "content-conflict" }] },
    });
    expect(result.grafts[0]!.intent.map((intent) => intent.description)).toContain("Use our policy on line four");
    expect(result.grafts[0]!.briefs[0]).toMatch(/^\.regraft\/briefs\//);
  });

  it("does not expose discarded historical Intent as active context", () => {
    const upstream = initUpstream({ "lib/file.txt": BASE });
    const project = makeProject();
    addCommand(`${upstream.url}#main:lib`, "vendor", { cwd: project, name: "auth" });
    writeFiles(project, { "vendor/file.txt": BASE.replace("line4", "LOCAL line4") });
    noteCommand("Historical policy that will be discarded", { cwd: project });
    commitUpstream(upstream, { "lib/file.txt": BASE.replace("line4", "UPSTREAM line4") });
    pullCommand({ cwd: project });
    pullCommand({ cwd: project, force: true });

    const result = inspectCommand({ cwd: project, grafts: ["auth"], offline: true });
    expect(result.grafts[0]!.intent).toEqual([]);
  });
});
