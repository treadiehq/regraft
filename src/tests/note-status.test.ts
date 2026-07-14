import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addCommand } from "../commands/add";
import { noteCommand } from "../commands/note";
import { statusCommand } from "../commands/status";
import { loadManifest } from "../core/manifest";
import { sha256 } from "../core/hash";
import { cleanupTempDirs, commitUpstream, initUpstream, makeProject, writeFiles, type Upstream } from "./helpers";

afterAll(cleanupTempDirs);

function setup(): { up: Upstream; project: string } {
  const up = initUpstream({ "lib/a.ts": "alpha\n", "lib/b.ts": "beta\n" });
  const project = makeProject();
  addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
  return { up, project };
}

describe("regraft status", () => {
  it("is clean (exit 0) right after add", () => {
    const { project } = setup();
    const result = statusCommand({ cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result).toMatchObject({ clean: true, stale: false, drifted: false });
    expect(result.sources[0]!.files.every((f) => f.status === "clean")).toBe(true);
  });

  it("classifies unrecorded modifications and fails the exit code", () => {
    const { project } = setup();
    writeFiles(project, { "vendor/a.ts": "alpha CUSTOMIZED\n" });
    const result = statusCommand({ cwd: project });
    expect(result.exitCode).toBe(1);
    expect(result.drifted).toBe(true);
    expect(result.sources[0]!.files.find((f) => f.path === "vendor/a.ts")!.status).toBe("modified-unrecorded");
  });

  it("classifies intent-covered modifications as modified+intent and exits 0", () => {
    const { project } = setup();
    writeFiles(project, { "vendor/a.ts": "alpha CUSTOMIZED\n" });
    noteCommand("Customized alpha for reasons", { cwd: project });
    const result = statusCommand({ cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.drifted).toBe(true);
    expect(result.clean).toBe(false);
    expect(result.sources[0]!.files.find((f) => f.path === "vendor/a.ts")!.status).toBe("modified+intent");
  });

  it("re-modifying after a note goes back to modified-unrecorded", () => {
    const { project } = setup();
    writeFiles(project, { "vendor/a.ts": "v2 of my customization\n" });
    noteCommand("First customization", { cwd: project });
    writeFiles(project, { "vendor/a.ts": "v3, different again\n" });
    const result = statusCommand({ cwd: project });
    expect(result.exitCode).toBe(1);
    expect(result.sources[0]!.files.find((f) => f.path === "vendor/a.ts")!.status).toBe("modified-unrecorded");
  });

  it("classifies missing files and fails", () => {
    const { project } = setup();
    rmSync(join(project, "vendor/b.ts"));
    const result = statusCommand({ cwd: project });
    expect(result.exitCode).toBe(1);
    expect(result.sources[0]!.files.find((f) => f.path === "vendor/b.ts")!.status).toBe("missing");
  });

  it("detects stale sources (upstream moved) and fails even when files are clean", () => {
    const { up, project } = setup();
    commitUpstream(up, { "lib/a.ts": "alpha v2\n" });
    const result = statusCommand({ cwd: project });
    expect(result.exitCode).toBe(1);
    expect(result.stale).toBe(true);
    expect(result.sources[0]!.stale).toBe(true);
    expect(result.sources[0]!.upstreamSha).toBe(up.sha);
    expect(result.sources[0]!.files.every((f) => f.status === "clean")).toBe(true);
  });

  it("returns a stable --json shape", () => {
    const { project } = setup();
    const result = statusCommand({ cwd: project });
    expect(Object.keys(result).sort()).toEqual(
      ["clean", "command", "drifted", "exitCode", "offline", "sources", "stale"].sort(),
    );
    expect(Object.keys(result.sources[0]!).sort()).toEqual(
      ["dest", "files", "id", "name", "path", "pinnedSha", "remoteRef", "stale", "upstreamSha", "url"].sort(),
    );
    expect(Object.keys(result.sources[0]!.files[0]!).sort()).toEqual(["path", "status"].sort());
  });

  it("--offline skips upstream checks entirely (works with no network)", () => {
    const { up, project } = setup();
    // Prove no upstream contact happens: make the remote unreachable.
    rmSync(up.dir, { recursive: true, force: true });
    expect(() => statusCommand({ cwd: project })).toThrow(); // online needs the remote
    const result = statusCommand({ cwd: project, offline: true });
    expect(result.exitCode).toBe(0);
    expect(result.offline).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.sources[0]!.upstreamSha).toBeNull();
    expect(result.sources[0]!.stale).toBeNull();
  });

  it("--offline still fails on local drift", () => {
    const { project } = setup();
    writeFiles(project, { "vendor/a.ts": "alpha CUSTOMIZED\n" });
    const result = statusCommand({ cwd: project, offline: true });
    expect(result.exitCode).toBe(1);
    expect(result.drifted).toBe(true);
    expect(result.sources[0]!.files.find((f) => f.path === "vendor/a.ts")!.status).toBe("modified-unrecorded");
  });
});

describe("regraft note", () => {
  it("snapshots current disk hashes and regenerates PATCH.md", () => {
    const { project } = setup();
    writeFiles(project, { "vendor/a.ts": "customized alpha\n" });
    const result = noteCommand("Why alpha changed", { cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.intent.targets).toMatchObject([
      { kind: "graft-file", path: "vendor/a.ts", hash: sha256("customized alpha\n") },
    ]);
    expect(result.intent.id).toMatch(/^[0-9a-f]{8}$/);

    const manifest = loadManifest(project)!;
    expect(manifest.intents).toHaveLength(1);
    const md = readFileSync(join(project, "PATCH.md"), "utf8");
    expect(md).toContain("Why alpha changed");
    expect(md).toContain("`vendor/a.ts`");
  });

  it("defaults to modified files not already covered at their current hash", () => {
    const { project } = setup();
    writeFiles(project, { "vendor/a.ts": "change one\n" });
    noteCommand("first", { cwd: project });
    writeFiles(project, { "vendor/b.ts": "change two\n" });
    const result = noteCommand("second", { cwd: project });
    // a.ts unchanged since the first note -> covered; only b.ts snapshotted
    expect(result.intent.targets.map((target) => target.path)).toEqual(["vendor/b.ts"]);
  });

  it("refuses when there is nothing to record", () => {
    const { project } = setup();
    expect(() => noteCommand("nothing changed", { cwd: project })).toThrow(/Nothing to record/);
  });

  it("accepts an explicit --files list, even for unmodified tracked files", () => {
    const { project } = setup();
    const result = noteCommand("pin b as-is", { cwd: project, files: ["./vendor/b.ts"] });
    expect(result.intent.targets.map((target) => target.path)).toEqual(["vendor/b.ts"]);
  });

  it("records an intentional local deletion as Intent", () => {
    const { project } = setup();
    rmSync(join(project, "vendor/b.ts"));
    const result = noteCommand("Remove the optional beta surface", {
      cwd: project,
      files: ["vendor/b.ts"],
    });
    expect(result.intent.targets[0]).toMatchObject({ path: "vendor/b.ts", hash: null });
    const status = statusCommand({ cwd: project, offline: true });
    expect(status.exitCode).toBe(0);
    expect(status.sources[0]!.files.find((file) => file.path === "vendor/b.ts")!.status).toBe(
      "modified+intent",
    );
  });

  it("rejects --files entries that are not tracked", () => {
    const { project } = setup();
    writeFiles(project, { "random.txt": "hi\n" });
    expect(() => noteCommand("bad", { cwd: project, files: ["random.txt"] })).toThrow(/not a tracked file/);
  });

  it("rejects empty descriptions", () => {
    const { project } = setup();
    expect(() => noteCommand("   ", { cwd: project })).toThrow(/must not be empty/);
  });

  it("refuses concurrent state-changing operations", () => {
    const { project } = setup();
    writeFiles(project, { "vendor/a.ts": "changed\n" });
    mkdirSync(join(project, ".regraft/operation.lock"));
    expect(() => noteCommand("Concurrent note", { cwd: project })).toThrow(/Another Regraft operation/);
  });
});
