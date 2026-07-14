import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addCommand } from "../commands/add";
import { noteCommand } from "../commands/note";
import { removeCommand } from "../commands/remove";
import { loadManifest } from "../core/manifest";
import { cleanupTempDirs, initUpstream, makeProject, writeFiles } from "./helpers";

afterAll(cleanupTempDirs);

describe("regraft remove", () => {
  it("untracks by URL substring, keeping files on disk", () => {
    const up = initUpstream({ "lib/a.ts": "a\n" });
    const project = makeProject();
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });

    const result = removeCommand(up.dir.split("/").pop()!, { cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.hard).toBe(false);
    expect(result.deletedFiles).toEqual([]);
    expect(loadManifest(project)!.grafts).toEqual([]);
    expect(existsSync(join(project, "vendor/a.ts"))).toBe(true);
  });

  it("--hard also deletes tracked files and prunes empty directories", () => {
    const up = initUpstream({ "lib/a.ts": "a\n", "lib/deep/b.ts": "b\n" });
    const project = makeProject();
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });

    const result = removeCommand(up.url, { cwd: project, hard: true });
    expect(result.deletedFiles.sort()).toEqual(["vendor/a.ts", "vendor/deep/b.ts"]);
    expect(existsSync(join(project, "vendor"))).toBe(false);
  });

  it("keeps intent entries as history and marks them orphaned in PATCH.md", () => {
    const up = initUpstream({ "lib/a.ts": "a\n" });
    const project = makeProject();
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
    writeFiles(project, { "vendor/a.ts": "customized\n" });
    noteCommand("Important local customization", { cwd: project });

    removeCommand(up.url, { cwd: project });
    const manifest = loadManifest(project)!;
    expect(manifest.intents).toHaveLength(1); // history preserved
    const md = readFileSync(join(project, "PATCH.md"), "utf8");
    expect(md).toContain("Important local customization");
    expect(md).toContain("orphaned");
  });

  it("does not reactivate historical Intent when a new Graft reuses the destination", () => {
    const oldUpstream = initUpstream({ "lib/a.ts": "a\n" });
    const newUpstream = initUpstream({ "lib/a.ts": "replacement\n" });
    const project = makeProject();
    addCommand(`${oldUpstream.url}#main:lib`, "vendor", { cwd: project, name: "old-lib" });
    writeFiles(project, { "vendor/a.ts": "customized old behavior\n" });
    noteCommand("Intent belonging only to the old Graft", { cwd: project });
    removeCommand("old-lib", { cwd: project, hard: true });
    addCommand(`${newUpstream.url}#main:lib`, "vendor", { cwd: project, name: "new-lib" });

    const md = readFileSync(join(project, "PATCH.md"), "utf8");
    expect(md).toContain("Intent belonging only to the old Graft");
    expect(md).toContain("orphaned");
    expect(loadManifest(project)!.grafts[0]!.files["a.ts"]!.intentIds).toEqual([]);
  });

  it("matches on dest substrings too (people type the folder name)", () => {
    const up = initUpstream({ "lib/a.ts": "a\n" });
    const project = makeProject();
    addCommand(`${up.url}#main:lib`, "vendor/widgets", { cwd: project });

    const result = removeCommand("vendor/widgets", { cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.removed.dest).toBe("vendor/widgets");
    expect(loadManifest(project)!.grafts).toEqual([]);
  });

  it("errors when a dest query is ambiguous, listing the matches", () => {
    const upA = initUpstream({ "a.ts": "a\n" });
    const upB = initUpstream({ "b.ts": "b\n" });
    const project = makeProject();
    addCommand(upA.url, "vendored/a", { cwd: project });
    addCommand(upB.url, "vendored/b", { cwd: project });
    expect(() => removeCommand("vendored", { cwd: project })).toThrow(/matches 2 sources/);
  });

  it("errors with the tracked list when nothing matches", () => {
    const up = initUpstream({ "lib/a.ts": "a\n" });
    const project = makeProject();
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
    expect(() => removeCommand("zzz-no-match", { cwd: project })).toThrow(new RegExp(`Known Grafts:[\\s\\S]*${up.dir.split("/").pop()!}`));
  });

  it("errors when the query is ambiguous, listing the matches", () => {
    const upA = initUpstream({ "a.ts": "a\n" });
    const upB = initUpstream({ "b.ts": "b\n" });
    const project = makeProject();
    addCommand(upA.url, "vendored-a", { cwd: project });
    addCommand(upB.url, "vendored-b", { cwd: project });
    // both fixture URLs share the tmpdir prefix
    expect(() => removeCommand("regraft-upstream-", { cwd: project })).toThrow(/matches 2 sources/);
  });

  it("returns a stable --json shape", () => {
    const up = initUpstream({ "lib/a.ts": "a\n" });
    const project = makeProject();
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
    const result = removeCommand(up.url, { cwd: project, hard: true });
    expect(Object.keys(result).sort()).toEqual(["command", "deletedFiles", "exitCode", "hard", "removed"].sort());
    expect(Object.keys(result.removed).sort()).toEqual(["dest", "id", "name", "path", "remoteRef", "url"].sort());
  });
});
