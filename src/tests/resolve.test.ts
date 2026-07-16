import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addCommand } from "../commands/add";
import { noteCommand } from "../commands/note";
import { pullCommand } from "../commands/pull";
import { resolveCommand } from "../commands/resolve";
import { statusCommand } from "../commands/status";
import { sha256 } from "../core/hash";
import { loadManifest } from "../core/manifest";
import { cleanupTempDirs, commitUpstream, initUpstream, makeProject, writeFiles } from "./helpers";

afterAll(cleanupTempDirs);

const BASE = "one\ntwo\nthree\nfour\nfive\n";
const RECONCILED = "one\nreconciled two\nthree\nfour\nfive\n";

/** Build a project with a real conflict from a pull. */
function setupConflict(): string {
  const up = initUpstream({ "lib/file.txt": BASE });
  const project = makeProject();
  addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
  writeFiles(project, { "vendor/file.txt": BASE.replace("two", "LOCAL two") });
  noteCommand("Line two customized", { cwd: project });
  commitUpstream(up, { "lib/file.txt": BASE.replace("two", "UPSTREAM two") });
  const pull = pullCommand({ cwd: project });
  if (pull.sources[0]!.conflicts.length !== 1) throw new Error("fixture should conflict");
  return project;
}

describe("regraft resolve", () => {
  it("errors (exit 1) listing offenders while markers remain, changing nothing", () => {
    const project = setupConflict();
    const result = resolveCommand({ cwd: project });
    expect(result.exitCode).toBe(1);
    expect(result.markersRemain).toEqual(["vendor/file.txt"]);
    expect(result.resolved).toEqual([]);
    expect(loadManifest(project)!.grafts[0]!.files["file.txt"]!.pending?.kind).toBe("content-conflict");
  });

  it("happy path with --note: clears unresolved, updates stored hash, records intent", () => {
    const project = setupConflict();
    writeFiles(project, { "vendor/file.txt": RECONCILED });

    const result = resolveCommand({ cwd: project, note: "Re-applied line-two customization on new upstream" });
    expect(result.exitCode).toBe(0);
    expect(result.resolved).toEqual(["vendor/file.txt"]);
    expect(result.needsNote).toEqual([]);
    expect(result.note).not.toBeNull();

    const manifest = loadManifest(project)!;
    expect(manifest.grafts[0]!.files["file.txt"]!.pending).toBeNull();
    expect(manifest.grafts[0]!.files["file.txt"]!.localHash).toBe(sha256(RECONCILED));
    expect(manifest.intents.at(-1)!.description).toContain("Re-applied");
    expect(readFileSync(join(project, "PATCH.md"), "utf8")).toContain("Re-applied line-two customization");

    // Full loop closes: status is clean again (upstream is at the pinned SHA)
    expect(statusCommand({ cwd: project }).exitCode).toBe(0);
  });

  it("without --note: resolves but exits 1 pointing at `regraft note`", () => {
    const project = setupConflict();
    writeFiles(project, { "vendor/file.txt": RECONCILED });

    const result = resolveCommand({ cwd: project });
    expect(result.exitCode).toBe(1);
    expect(result.resolved).toEqual(["vendor/file.txt"]);
    expect(result.needsNote).toEqual(["vendor/file.txt"]);
    expect(result.note).toBeNull();
    // state was still updated
    expect(loadManifest(project)!.grafts[0]!.files["file.txt"]!.pending).toBeNull();

    // the suggested follow-up works and covers the file
    noteCommand("Resolution rationale", { cwd: project, files: ["vendor/file.txt"] });
    expect(loadManifest(project)!.intents.at(-1)!.targets[0]!.hash).toBe(sha256(RECONCILED));
  });

  it("exits 0 when the resolved content is already covered by an intent snapshot", () => {
    const project = setupConflict();
    writeFiles(project, { "vendor/file.txt": RECONCILED });
    noteCommand("Pre-recorded the reconciliation", { cwd: project, files: ["vendor/file.txt"] });

    const result = resolveCommand({ cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.needsNote).toEqual([]);
  });

  it("reuses existing Intent after unrecorded WIP is reverted during resolution", () => {
    const upstream = initUpstream({ "lib/file.txt": BASE });
    const project = makeProject();
    addCommand(`${upstream.url}#main:lib`, "vendor", { cwd: project });
    const recorded = BASE.replace("two", "LOCAL two");
    writeFiles(project, { "vendor/file.txt": recorded });
    const originalIntent = noteCommand("Keep the line-two customization", { cwd: project });

    writeFiles(project, { "vendor/file.txt": BASE.replace("two", "WIP two") });
    commitUpstream(upstream, { "lib/file.txt": BASE.replace("two", "UPSTREAM two") });
    expect(pullCommand({ cwd: project }).sources[0]!.conflicts).toEqual(["vendor/file.txt"]);
    expect(loadManifest(project)!.grafts[0]!.files["file.txt"]!.needsIntent).toBe(true);

    writeFiles(project, { "vendor/file.txt": recorded });
    const result = resolveCommand({ cwd: project });

    expect(result.exitCode).toBe(0);
    expect(result.needsNote).toEqual([]);
    const manifest = loadManifest(project)!;
    const file = manifest.grafts[0]!.files["file.txt"]!;
    expect(file.pending).toBeNull();
    expect(file.needsIntent).toBe(false);
    expect(file.intentIds).toEqual([originalIntent.intent.id]);
    expect(manifest.intents).toHaveLength(1);
  });

  it("still requires Intent when accepted local content has never been explained", () => {
    const upstream = initUpstream({ "lib/file.txt": BASE });
    const project = makeProject();
    addCommand(`${upstream.url}#main:lib`, "vendor", { cwd: project });
    const explained = BASE.replace("one", "LOCAL one");
    writeFiles(project, { "vendor/file.txt": explained });
    noteCommand("Keep the line-one customization", { cwd: project });

    const wip = explained.replace("two", "WIP two");
    writeFiles(project, { "vendor/file.txt": wip });
    const upstreamV2 = BASE.replace("five", "UPSTREAM five");
    commitUpstream(upstream, { "lib/file.txt": upstreamV2 });
    expect(pullCommand({ cwd: project }).sources[0]!.merged).toEqual(["vendor/file.txt"]);
    const unexplained = readFileSync(join(project, "vendor/file.txt"), "utf8");
    expect(loadManifest(project)!.grafts[0]!.files["file.txt"]!.needsIntent).toBe(true);

    commitUpstream(upstream, { "lib/file.txt": upstreamV2.replace("two", "UPSTREAM two") });
    expect(pullCommand({ cwd: project }).sources[0]!.conflicts).toEqual(["vendor/file.txt"]);
    writeFiles(project, { "vendor/file.txt": unexplained });

    const result = resolveCommand({ cwd: project });
    expect(result.exitCode).toBe(1);
    expect(result.needsNote).toEqual(["vendor/file.txt"]);
    const file = loadManifest(project)!.grafts[0]!.files["file.txt"]!;
    expect(file.pending).toBeNull();
    expect(file.needsIntent).toBe(true);
  });

  it("is idempotent: nothing unresolved is an explicit no-op", () => {
    const up = initUpstream({ "lib/a.txt": "a\n" });
    const project = makeProject();
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
    const result = resolveCommand({ cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.resolved).toEqual([]);
  });

  it("rejects explicit files that are not marked unresolved", () => {
    const up = initUpstream({ "lib/a.txt": "a\n" });
    const project = makeProject();
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
    expect(() => resolveCommand({ cwd: project, files: ["vendor/a.txt"] })).toThrow(/no pending judgment/);
  });

  it("returns a stable --json shape", () => {
    const project = setupConflict();
    writeFiles(project, { "vendor/file.txt": RECONCILED });
    const result = resolveCommand({ cwd: project, note: "done" });
    expect(Object.keys(result).sort()).toEqual(["command", "exitCode", "markersRemain", "needsNote", "note", "resolved"].sort());
  });
});
