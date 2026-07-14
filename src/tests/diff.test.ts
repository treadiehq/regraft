import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addCommand } from "../commands/add";
import { diffCommand } from "../commands/diff";
import { pullCommand } from "../commands/pull";
import { unifiedDiff } from "../core/diff";
import { cleanupTempDirs, commitUpstream, initUpstream, makeProject, writeFiles } from "./helpers";

afterAll(cleanupTempDirs);

describe("regraft diff (local drift)", () => {
  it("rejects unsafe diff labels before writing temp files", () => {
    expect(() => unifiedDiff("../../escaped.txt", Buffer.from("a\n"), Buffer.from("b\n"))).toThrow(/project-relative/);
    expect(() => unifiedDiff("/tmp/escaped.txt", Buffer.from("a\n"), Buffer.from("b\n"))).toThrow(/project-relative/);
  });

  it("shows a unified diff of local edits against the vendored baseline", () => {
    const up = initUpstream({ "lib/theme.ts": "old tokens\n", "lib/util.ts": "util\n" });
    const project = makeProject();
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
    writeFiles(project, { "vendor/theme.ts": "brand tokens\n" });

    const result = diffCommand({ cwd: project });
    expect(result.exitCode).toBe(1);
    expect(result.upstream).toBe(false);
    const files = result.sources[0]!.files;
    expect(files).toHaveLength(1);
    const entry = files[0]!;
    expect(entry.path).toBe("vendor/theme.ts");
    expect(entry.change).toBe("modified");
    expect(entry.diff).toContain("-old tokens");
    expect(entry.diff).toContain("+brand tokens");
    expect(entry.diff).toContain("vendor/theme.ts");
  });

  it("exits 0 with no entries when nothing drifted", () => {
    const up = initUpstream({ "lib/a.ts": "a\n" });
    const project = makeProject();
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });

    const result = diffCommand({ cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.sources[0]!.files).toEqual([]);
  });

  it("reports missing files without a diff", () => {
    const up = initUpstream({ "lib/a.ts": "a\n" });
    const project = makeProject();
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
    rmSync(join(project, "vendor/a.ts"));

    const result = diffCommand({ cwd: project });
    expect(result.exitCode).toBe(1);
    const entry = result.sources[0]!.files[0]!;
    expect(entry.change).toBe("missing");
    expect(entry.diff).toBe("");
  });

  it("marks binary files and skips the text diff", () => {
    const up = initUpstream({ "lib/logo.bin": Buffer.from([0, 1, 2, 3]) });
    const project = makeProject();
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
    writeFiles(project, { "vendor/logo.bin": Buffer.from([0, 9, 9, 9]) });

    const result = diffCommand({ cwd: project });
    const entry = result.sources[0]!.files[0]!;
    expect(entry.binary).toBe(true);
    expect(entry.diff).toBe("");
    expect(entry.note).toContain("binary");
  });

  it("marks a locally modified binary as binary after upstream deletes it", () => {
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const local = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]);
    const up = initUpstream({ "lib/logo.png": original });
    const project = makeProject();
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
    writeFiles(project, { "vendor/logo.png": local });
    const deletedAt = commitUpstream(up, {}, { remove: ["lib/logo.png"] });

    const pull = pullCommand({ cwd: project });
    expect(pull.sources[0]!.warnings[0]).toMatchObject({ path: "vendor/logo.png" });

    const result = diffCommand({ cwd: project });
    const entry = result.sources[0]!.files[0]!;
    expect(result.sources[0]!.pinnedSha).toBe(deletedAt);
    expect(entry).toMatchObject({
      path: "vendor/logo.png",
      change: "modified",
      binary: true,
      diff: "",
    });
    expect(entry.note).toContain("no baseline");
    expect(entry.note).toContain("binary");
  });

  it("scopes to explicit files and rejects untracked paths", () => {
    const up = initUpstream({ "lib/a.ts": "a\n", "lib/b.ts": "b\n" });
    const project = makeProject();
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
    writeFiles(project, { "vendor/a.ts": "a changed\n", "vendor/b.ts": "b changed\n" });

    const scoped = diffCommand({ cwd: project, files: ["vendor/a.ts"] });
    expect(scoped.sources[0]!.files.map((f) => f.path)).toEqual(["vendor/a.ts"]);

    expect(() => diffCommand({ cwd: project, files: ["nope/x.ts"] })).toThrow(/not a tracked file/);
  });

  it("works for single-file sources (rel '')", () => {
    const up = initUpstream({ "src/utils.ts": "v1\n" });
    const project = makeProject();
    addCommand(`${up.url}#main:src/utils.ts`, "lib/utils.ts", { cwd: project });
    writeFiles(project, { "lib/utils.ts": "v2\n" });

    const result = diffCommand({ cwd: project });
    const entry = result.sources[0]!.files[0]!;
    expect(entry.path).toBe("lib/utils.ts");
    expect(entry.diff).toContain("-v1");
    expect(entry.diff).toContain("+v2");
  });
});

describe("regraft diff --upstream", () => {
  it("shows what upstream changed since the pinned commit", () => {
    const up = initUpstream({ "lib/a.ts": "v1\n", "lib/gone.ts": "bye\n" });
    const project = makeProject();
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
    commitUpstream(up, { "lib/a.ts": "v2\n", "lib/new.ts": "hello\n" }, { remove: ["lib/gone.ts"] });

    const result = diffCommand({ cwd: project, upstream: true });
    expect(result.exitCode).toBe(1);
    expect(result.upstream).toBe(true);
    const source = result.sources[0]!;
    expect(source.upstreamSha).toBe(up.sha);

    const byPath = new Map(source.files.map((f) => [f.path, f]));
    expect(byPath.get("vendor/a.ts")!.change).toBe("modified");
    expect(byPath.get("vendor/a.ts")!.diff).toContain("+v2");
    expect(byPath.get("vendor/new.ts")!.change).toBe("added");
    expect(byPath.get("vendor/new.ts")!.diff).toContain("+hello");
    expect(byPath.get("vendor/gone.ts")!.change).toBe("deleted");
  });

  it("returns no entries when the source is up to date", () => {
    const up = initUpstream({ "lib/a.ts": "a\n" });
    const project = makeProject();
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });

    const result = diffCommand({ cwd: project, upstream: true });
    expect(result.exitCode).toBe(0);
    expect(result.sources[0]!.files).toEqual([]);
  });

  it("returns a stable --json shape", () => {
    const up = initUpstream({ "lib/a.ts": "a\n" });
    const project = makeProject();
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
    writeFiles(project, { "vendor/a.ts": "changed\n" });

    const result = diffCommand({ cwd: project });
    expect(Object.keys(result).sort()).toEqual(["command", "exitCode", "sources", "upstream"].sort());
    expect(Object.keys(result.sources[0]!).sort()).toEqual(
      ["dest", "files", "id", "name", "path", "pinnedSha", "remoteRef", "upstreamSha", "url"].sort(),
    );
    expect(Object.keys(result.sources[0]!.files[0]!).sort()).toEqual(
      ["binary", "change", "diff", "note", "path"].sort(),
    );
  });
});
