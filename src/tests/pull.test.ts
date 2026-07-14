import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addCommand } from "../commands/add";
import { noteCommand } from "../commands/note";
import { pullCommand } from "../commands/pull";
import { sha256 } from "../core/hash";
import { loadManifest } from "../core/manifest";
import { cleanupTempDirs, commitUpstream, initUpstream, makeProject, writeFiles, type Upstream } from "./helpers";

afterAll(cleanupTempDirs);

const BASE = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n";

function setup(files: Record<string, string | Buffer> = { "lib/file.txt": BASE }): { up: Upstream; project: string } {
  const up = initUpstream(files);
  const project = makeProject();
  addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
  return { up, project };
}

describe("regraft pull", () => {
  it("is a no-op when already at the upstream SHA", () => {
    const { project } = setup();
    const result = pullCommand({ cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.sources[0]!.upToDate).toBe(true);
    expect(result.brief).toBeNull();
  });

  it("fast-forwards unmodified files and updates pinned SHA and stored hash", () => {
    const { up, project } = setup();
    const v2 = commitUpstream(up, { "lib/file.txt": BASE + "line9\n" });

    const result = pullCommand({ cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.sources[0]!.fastForwarded).toEqual(["vendor/file.txt"]);
    expect(readFileSync(join(project, "vendor/file.txt"), "utf8")).toBe(BASE + "line9\n");

    const source = loadManifest(project)!.sources[0]!;
    expect(source.pinnedSha).toBe(v2);
    expect(source.files["file.txt"]).toBe(sha256(BASE + "line9\n"));
  });

  it("leaves locally modified files alone when upstream did not touch them", () => {
    const { up, project } = setup({ "lib/file.txt": BASE, "lib/other.txt": "other\n" });
    writeFiles(project, { "vendor/file.txt": "totally mine now\n" });
    commitUpstream(up, { "lib/other.txt": "other v2\n" });

    const result = pullCommand({ cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.sources[0]!.fastForwarded).toEqual(["vendor/other.txt"]);
    expect(readFileSync(join(project, "vendor/file.txt"), "utf8")).toBe("totally mine now\n");
    // stored hash for the modified file stays at what regraft last wrote
    expect(loadManifest(project)!.sources[0]!.files["file.txt"]).toBe(sha256(BASE));
  });

  it("three-way merges non-overlapping local and upstream edits cleanly", () => {
    const { up, project } = setup();
    writeFiles(project, { "vendor/file.txt": BASE.replace("line1", "LOCAL line1") });
    commitUpstream(up, { "lib/file.txt": BASE.replace("line8", "UPSTREAM line8") });

    const result = pullCommand({ cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.sources[0]!.merged).toEqual(["vendor/file.txt"]);
    const merged = readFileSync(join(project, "vendor/file.txt"), "utf8");
    expect(merged).toContain("LOCAL line1");
    expect(merged).toContain("UPSTREAM line8");
    expect(merged).not.toContain("<<<<<<<");
    expect(loadManifest(project)!.sources[0]!.files["file.txt"]).toBe(sha256(merged));
  });

  it("writes inline diff3 markers on true conflicts and generates a brief", () => {
    const { up, project } = setup();
    writeFiles(project, { "vendor/file.txt": BASE.replace("line4", "LOCAL line4") });
    noteCommand("Line 4 carries our custom retry logic", { cwd: project });
    const v2 = commitUpstream(up, { "lib/file.txt": BASE.replace("line4", "UPSTREAM line4") }, { message: "rework line4" });

    const result = pullCommand({ cwd: project });
    expect(result.exitCode).toBe(1);
    expect(result.conflicts).toBe(true);
    expect(result.sources[0]!.conflicts).toEqual(["vendor/file.txt"]);

    const text = readFileSync(join(project, "vendor/file.txt"), "utf8");
    expect(text).toContain("<<<<<<< local");
    expect(text).toContain("||||||| base");
    expect(text).toContain(">>>>>>> upstream");
    expect(text).toContain("LOCAL line4");
    expect(text).toContain("UPSTREAM line4");
    expect(text.startsWith("line1\n")).toBe(true); // markers inline, not prepended

    const source = loadManifest(project)!.sources[0]!;
    expect(source.unresolved).toEqual(["file.txt"]);
    expect(source.pinnedSha).toBe(v2); // pinned SHA still advances

    expect(result.brief).toMatch(/^\.regraft\/briefs\/.*\.md$/);
    const brief = readFileSync(join(project, result.brief!), "utf8");
    expect(brief).toContain("vendor/file.txt");
    expect(brief).toContain("Line 4 carries our custom retry logic"); // full intent text
    expect(brief).toContain("rework line4"); // upstream commit messages
    expect(brief).toContain("regraft resolve"); // agent instructions
  });

  it("skips unresolved files on subsequent pulls (no marker stacking)", () => {
    const { up, project } = setup();
    writeFiles(project, { "vendor/file.txt": BASE.replace("line4", "LOCAL line4") });
    commitUpstream(up, { "lib/file.txt": BASE.replace("line4", "UPSTREAM line4") });
    pullCommand({ cwd: project });
    const conflicted = readFileSync(join(project, "vendor/file.txt"), "utf8");

    commitUpstream(up, { "lib/file.txt": BASE.replace("line4", "UPSTREAM AGAIN line4") });
    const second = pullCommand({ cwd: project });
    expect(second.sources[0]!.conflicts).toEqual([]);
    expect(second.sources[0]!.skipped[0]).toMatchObject({ path: "vendor/file.txt" });
    expect(second.sources[0]!.skipped[0]!.reason).toContain("resolve");
    expect(second.sources[0]!.warnings[0]).toMatchObject({ path: "vendor/file.txt" });
    expect(second.sources[0]!.warnings[0]!.message).toContain("upstream changed");
    // untouched: same single set of markers
    expect(readFileSync(join(project, "vendor/file.txt"), "utf8")).toBe(conflicted);
    expect((conflicted.match(/<<<<<<</g) ?? []).length).toBe(1);
  });

  it("warns when upstream deletes an unresolved file on a later pull", () => {
    const { up, project } = setup();
    writeFiles(project, { "vendor/file.txt": BASE.replace("line4", "LOCAL line4") });
    commitUpstream(up, { "lib/file.txt": BASE.replace("line4", "UPSTREAM line4") });
    pullCommand({ cwd: project });
    const conflicted = readFileSync(join(project, "vendor/file.txt"), "utf8");

    const v3 = commitUpstream(up, {}, { remove: ["lib/file.txt"], message: "delete conflicted file" });
    const second = pullCommand({ cwd: project });

    expect(second.exitCode).toBe(1);
    expect(second.sources[0]!.skipped[0]).toMatchObject({ path: "vendor/file.txt" });
    expect(second.sources[0]!.warnings[0]).toMatchObject({ path: "vendor/file.txt" });
    expect(second.sources[0]!.warnings[0]!.message).toContain("deleted");
    expect(readFileSync(join(project, "vendor/file.txt"), "utf8")).toBe(conflicted);
    expect(loadManifest(project)!.sources[0]!.pinnedSha).toBe(v3);
    expect(second.brief).not.toBeNull();
    const brief = readFileSync(join(project, second.brief!), "utf8");
    expect(brief).toContain("vendor/file.txt");
    expect(brief).toContain("delete conflicted file");
  });

  it("adds new upstream files and deletes upstream-deleted unmodified files", () => {
    const { up, project } = setup({ "lib/old.txt": "old\n", "lib/keep.txt": "keep\n" });
    commitUpstream(up, { "lib/new.txt": "new file\n" }, { remove: ["lib/old.txt"] });

    const result = pullCommand({ cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.sources[0]!.added).toEqual(["vendor/new.txt"]);
    expect(result.sources[0]!.deleted).toEqual(["vendor/old.txt"]);
    expect(readFileSync(join(project, "vendor/new.txt"), "utf8")).toBe("new file\n");
    expect(existsSync(join(project, "vendor/old.txt"))).toBe(false);

    const source = loadManifest(project)!.sources[0]!;
    expect(Object.keys(source.files).sort()).toEqual(["keep.txt", "new.txt"]);
  });

  it("keeps locally modified files that upstream deleted, with a warning and brief", () => {
    const { up, project } = setup({ "lib/gone.txt": "original\n" });
    writeFiles(project, { "vendor/gone.txt": "heavily customized\n" });
    commitUpstream(up, {}, { remove: ["lib/gone.txt"] });

    const result = pullCommand({ cwd: project });
    expect(result.exitCode).toBe(1);
    expect(result.sources[0]!.warnings[0]).toMatchObject({ path: "vendor/gone.txt" });
    expect(result.sources[0]!.warnings[0]!.message).toContain("deleted");
    expect(readFileSync(join(project, "vendor/gone.txt"), "utf8")).toBe("heavily customized\n");
    expect(result.brief).not.toBeNull();
    expect(readFileSync(join(project, result.brief!), "utf8")).toContain("vendor/gone.txt");
  });

  it.skipIf(process.platform === "win32")("refuses a tracked symlink without modifying its target", () => {
    const { up, project } = setup({ "lib/file.txt": "version 1\n" });
    const tracked = join(project, "vendor/file.txt");
    rmSync(tracked);
    writeFiles(project, { "precious.txt": "keep me\n" });
    symlinkSync("../precious.txt", tracked);
    commitUpstream(up, { "lib/file.txt": "version 2\n" });

    expect(() => pullCommand({ cwd: project })).toThrow(/symbolic link/);
    expect(readFileSync(join(project, "precious.txt"), "utf8")).toBe("keep me\n");
    expect(lstatSync(tracked).isSymbolicLink()).toBe(true);
  });

  it("never merges binaries: conflicting binary changes are skipped with a warning", () => {
    const binV1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const binLocal = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]);
    const binV2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x03]);
    const { up, project } = setup({ "lib/logo.png": binV1 });
    writeFiles(project, { "vendor/logo.png": binLocal });
    commitUpstream(up, { "lib/logo.png": binV2 });

    const result = pullCommand({ cwd: project });
    expect(result.exitCode).toBe(1);
    expect(result.sources[0]!.warnings[0]!.message).toContain("binary");
    expect(readFileSync(join(project, "vendor/logo.png"))).toEqual(binLocal);
    expect(readFileSync(join(project, result.brief!), "utf8")).toContain("vendor/logo.png");
  });

  it("fast-forwards unmodified binaries", () => {
    const binV1 = Buffer.from([0x00, 0x01]);
    const binV2 = Buffer.from([0x00, 0x02]);
    const { up, project } = setup({ "lib/logo.png": binV1 });
    commitUpstream(up, { "lib/logo.png": binV2 });

    const result = pullCommand({ cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.sources[0]!.fastForwarded).toEqual(["vendor/logo.png"]);
    expect(readFileSync(join(project, "vendor/logo.png"))).toEqual(binV2);
  });

  it("--force takes upstream wholesale for conflicting files", () => {
    const { up, project } = setup();
    writeFiles(project, { "vendor/file.txt": BASE.replace("line4", "LOCAL line4") });
    const upstreamContent = BASE.replace("line4", "UPSTREAM line4");
    commitUpstream(up, { "lib/file.txt": upstreamContent });

    const result = pullCommand({ cwd: project, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.sources[0]!.forced).toEqual(["vendor/file.txt"]);
    expect(readFileSync(join(project, "vendor/file.txt"), "utf8")).toBe(upstreamContent);
    expect(loadManifest(project)!.sources[0]!.unresolved).toEqual([]);
  });

  it("--dry-run reports the plan but writes nothing", () => {
    const { up, project } = setup();
    writeFiles(project, { "vendor/file.txt": BASE.replace("line4", "LOCAL line4") });
    commitUpstream(up, { "lib/file.txt": BASE.replace("line4", "UPSTREAM line4") });
    const before = readFileSync(join(project, "vendor/file.txt"), "utf8");
    const pinnedBefore = loadManifest(project)!.sources[0]!.pinnedSha;

    const result = pullCommand({ cwd: project, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.sources[0]!.conflicts).toEqual(["vendor/file.txt"]);
    expect(result.brief).toBeNull();
    expect(readFileSync(join(project, "vendor/file.txt"), "utf8")).toBe(before);
    const manifest = loadManifest(project)!;
    expect(manifest.sources[0]!.pinnedSha).toBe(pinnedBefore);
    expect(manifest.sources[0]!.unresolved).toEqual([]);
    expect(existsSync(join(project, ".regraft/briefs"))).toBe(false);
  });

  it("nudges about unrecorded modifications without failing the pull", () => {
    const { up, project } = setup({ "lib/file.txt": BASE, "lib/other.txt": "other\n" });
    writeFiles(project, { "vendor/file.txt": "customized, no note recorded\n" });
    commitUpstream(up, { "lib/other.txt": "other v2\n" });

    const result = pullCommand({ cwd: project });
    expect(result.exitCode).toBe(0); // a nudge, never a failure
    expect(result.unrecordedModifications).toEqual(["vendor/file.txt"]);
  });

  it("does not nudge once modifications are covered by an intent", () => {
    const { up, project } = setup({ "lib/file.txt": BASE, "lib/other.txt": "other\n" });
    writeFiles(project, { "vendor/file.txt": "customized, with note\n" });
    noteCommand("Customized the file", { cwd: project });
    commitUpstream(up, { "lib/other.txt": "other v2\n" });

    const result = pullCommand({ cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.unrecordedModifications).toEqual([]);
  });

  it("returns a stable --json shape", () => {
    const { up, project } = setup();
    commitUpstream(up, { "lib/file.txt": BASE + "more\n" });
    const result = pullCommand({ cwd: project });
    expect(Object.keys(result).sort()).toEqual(
      ["brief", "command", "conflicts", "dryRun", "exitCode", "sources", "unrecordedModifications"].sort(),
    );
    expect(Object.keys(result.sources[0]!).sort()).toEqual(
      ["added", "conflicts", "deleted", "dest", "fastForwarded", "forced", "merged", "newSha", "oldSha", "remoteRef", "skipped", "upToDate", "url", "warnings"].sort(),
    );
  });
});
