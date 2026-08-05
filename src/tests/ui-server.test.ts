import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { addCommand } from "../commands/add";
import { noteCommand } from "../commands/note";
import { pullCommand } from "../commands/pull";
import { loadManifest } from "../core/manifest";
import { startUiServer, type UiServerHandle } from "../ui/server";
import { buildUiState } from "../ui/state";
import { requireManifest } from "../core/manifest";
import { cleanupTempDirs, commitUpstream, git, initUpstream, makeProject, writeFiles, type Upstream } from "./helpers";

afterAll(cleanupTempDirs);

const BASE = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n";

/** Upstream + project where line4 conflicts and extra.txt was deleted upstream. */
function conflictedFixture(): { up: Upstream; project: string } {
  const up = initUpstream({ "lib/file.txt": BASE, "lib/extra.txt": "extra\n" });
  const project = makeProject();
  addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
  writeFiles(project, {
    "vendor/file.txt": BASE.replace("line4", "LOCAL line4"),
    "vendor/extra.txt": "extra adapted\n",
  });
  noteCommand("Line 4 carries our retry logic", { cwd: project, files: ["vendor/file.txt"] });
  commitUpstream(up, { "lib/file.txt": BASE.replace("line4", "UPSTREAM line4") }, { remove: ["lib/extra.txt"] });
  const pulled = pullCommand({ cwd: project });
  expect(pulled.conflicts).toBe(true);
  return { up, project };
}

describe("buildUiState", () => {
  it("serializes pending conflicts with all three sides and intents", () => {
    const { project } = conflictedFixture();
    const state = buildUiState(project, requireManifest(project));

    expect(state.summary.conflicts).toBe(1);
    expect(state.summary.warnings).toBe(1);
    const graft = state.grafts[0]!;
    const conflicted = graft.files.find((file) => file.path === "vendor/file.txt")!;
    expect(conflicted.status).toBe("conflict-unresolved");
    expect(conflicted.intents[0]!.description).toContain("retry logic");

    const pending = conflicted.pending!;
    expect(pending.kind).toBe("content-conflict");
    expect(pending.base).toBe(BASE);
    expect(pending.upstream).toBe(BASE.replace("line4", "UPSTREAM line4"));
    expect(pending.local).toBe(BASE.replace("line4", "LOCAL line4"));
    expect(pending.conflictsRemaining).toBe(1);
    expect(pending.segments!.some((segment) => segment.type === "conflict")).toBe(true);
    expect(pending.upstreamCommits.length).toBeGreaterThan(0);

    const deleted = graft.files.find((file) => file.path === "vendor/extra.txt")!;
    expect(deleted.pending!.kind).toBe("upstream-deleted");
    expect(deleted.pending!.upstream).toBeNull();
    expect(deleted.pending!.working).toBe("extra adapted\n");
  });

  it("recovers the exact local version from the project's git history", () => {
    const up = initUpstream({ "lib/file.txt": BASE });
    const project = makeProject();
    git(project, "init", "-q", "-b", "main");
    git(project, "config", "user.email", "t@example.com");
    git(project, "config", "user.name", "t");
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
    writeFiles(project, { "vendor/file.txt": BASE.replace("line4", "LOCAL line4") });
    git(project, "add", "-A");
    git(project, "commit", "-qm", "adapt");
    commitUpstream(up, { "lib/file.txt": BASE.replace("line4", "UPSTREAM line4") });
    pullCommand({ cwd: project });

    const state = buildUiState(project, requireManifest(project));
    const pending = state.grafts[0]!.files[0]!.pending!;
    expect(pending.localExact).toBe(true);
    expect(pending.local).toBe(BASE.replace("line4", "LOCAL line4"));
  });
});

describe("ui server", () => {
  let handle: UiServerHandle;
  let project: string;
  let up: Upstream;

  beforeEach(async () => {
    ({ project, up } = conflictedFixture());
    handle = await startUiServer({ root: project });
  });

  afterEach(async () => {
    await handle.close();
  });

  function call(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${handle.port}${path}`, {
      ...init,
      headers: { "x-regraft-token": handle.token, ...init?.headers },
    });
  }

  it("rejects requests without the session token", async () => {
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/state`);
    expect(response.status).toBe(403);
  });

  it("serves the app shell and the state payload", async () => {
    const page = await call("/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<!doctype html>");

    const state = await call("/api/state");
    expect(state.status).toBe(200);
    const body = (await state.json()) as { summary: { conflicts: number } };
    expect(body.summary.conflicts).toBe(1);
  });

  it("applies a region choice, then resolves with a note", async () => {
    await call("/api/state"); // capture reset snapshots
    const region = await call("/api/region", {
      method: "POST",
      body: JSON.stringify({ path: "vendor/file.txt", index: 0, choice: "upstream" }),
    });
    expect(region.status).toBe(200);
    expect(readFileSync(join(project, "vendor/file.txt"), "utf8")).not.toContain("<<<<<<<");

    const resolve = await call("/api/resolve", {
      method: "POST",
      body: JSON.stringify({ files: ["vendor/file.txt"], note: "Took upstream's line4 rework" }),
    });
    const resolved = (await resolve.json()) as { resolved: string[]; markersRemain: string[] };
    expect(resolved.resolved).toEqual(["vendor/file.txt"]);
    expect(resolved.markersRemain).toEqual([]);
    expect(loadManifest(project)!.grafts[0]!.files["file.txt"]!.pending).toBeNull();
  });

  it("rejects invalid region choices without changing the file", async () => {
    const path = join(project, "vendor/file.txt");
    const before = readFileSync(path, "utf8");
    const response = await call("/api/region", {
      method: "POST",
      body: JSON.stringify({ path: "vendor/file.txt", index: 0, choice: "invalid" }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "region choice must be one of",
    );
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("resets a conflicted file to its captured merge state", async () => {
    await call("/api/state");
    await call("/api/region", {
      method: "POST",
      body: JSON.stringify({ path: "vendor/file.txt", index: 0, choice: "local" }),
    });
    const reset = await call("/api/file-action", {
      method: "POST",
      body: JSON.stringify({ path: "vendor/file.txt", action: "reset" }),
    });
    expect(reset.status).toBe(200);
    expect(readFileSync(join(project, "vendor/file.txt"), "utf8")).toContain("<<<<<<<");
  });

  it("refreshes the reset snapshot when the same file conflicts after a later pull", async () => {
    await call("/api/state");
    const firstConflict = readFileSync(join(project, "vendor/file.txt"), "utf8");
    expect(firstConflict).toContain("UPSTREAM line4");

    for (const path of ["vendor/file.txt", "vendor/extra.txt"]) {
      const resolved = await call("/api/file-action", {
        method: "POST",
        body: JSON.stringify({ path, action: "keep-local" }),
      });
      expect(resolved.status).toBe(200);
    }

    commitUpstream(up, { "lib/file.txt": BASE.replace("line4", "UPSTREAM V2 line4") });
    const pull = await call("/api/pull", { method: "POST", body: JSON.stringify({}) });
    expect(pull.status).toBe(200);
    expect(((await pull.json()) as { conflicts: boolean }).conflicts).toBe(true);

    await call("/api/state");
    const secondConflict = readFileSync(join(project, "vendor/file.txt"), "utf8");
    expect(secondConflict).toContain("UPSTREAM V2 line4");
    expect(secondConflict).not.toBe(firstConflict);

    const reset = await call("/api/file-action", {
      method: "POST",
      body: JSON.stringify({ path: "vendor/file.txt", action: "reset" }),
    });
    expect(reset.status).toBe(200);
    expect(readFileSync(join(project, "vendor/file.txt"), "utf8")).toBe(secondConflict);
  });

  it("handles an upstream-deleted file with keep-local", async () => {
    const response = await call("/api/file-action", {
      method: "POST",
      body: JSON.stringify({ path: "vendor/extra.txt", action: "keep-local" }),
    });
    expect(response.status).toBe(200);
    expect(readFileSync(join(project, "vendor/extra.txt"), "utf8")).toBe("extra adapted\n");
    const manifest = loadManifest(project)!;
    expect(manifest.grafts[0]!.files["extra.txt"]!.pending).toBeNull();
  });

  it("rejects actions that do not apply to the pending kind", async () => {
    const response = await call("/api/file-action", {
      method: "POST",
      body: JSON.stringify({ path: "vendor/extra.txt", action: "use-upstream" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("does not apply");
  });

  it("rejects restore for files without pending judgment", async () => {
    const response = await call("/api/restore", {
      method: "POST",
      body: JSON.stringify({ path: "vendor/nope.txt", text: "x" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("ui server review mode", () => {
  let handle: UiServerHandle;
  let project: string;

  /** Git-backed project so "your version" recovers byte-exact and review is available. */
  beforeEach(async () => {
    const up = initUpstream({ "lib/file.txt": BASE });
    project = makeProject();
    git(project, "init", "-q", "-b", "main");
    git(project, "config", "user.email", "t@example.com");
    git(project, "config", "user.name", "t");
    addCommand(`${up.url}#main:lib`, "vendor", { cwd: project });
    writeFiles(project, { "vendor/file.txt": BASE.replace("line4", "LOCAL line4") });
    git(project, "add", "-A");
    git(project, "commit", "-qm", "adapt");
    commitUpstream(up, { "lib/file.txt": BASE.replace("line4", "UPSTREAM line4") });
    pullCommand({ cwd: project });
    handle = await startUiServer({ root: project });
  });

  afterEach(async () => {
    await handle.close();
  });

  function call(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${handle.port}${path}`, {
      ...init,
      headers: { "x-regraft-token": handle.token, ...init?.headers },
    });
  }

  interface StatePayload {
    grafts: { files: { path: string; pending: { review: { status: string }[] | null; conflictsRemaining: number } | null }[] }[];
  }

  async function pendingOf(path: string) {
    const state = (await (await call("/api/state")).json()) as StatePayload;
    return state.grafts[0]!.files.find((file) => file.path === path)!.pending!;
  }

  it("classifies a resolution made outside the UI and reopens it", async () => {
    expect((await pendingOf("vendor/file.txt")).review!.map((region) => region.status)).toEqual(["unresolved"]);

    // An agent (or an editor) resolves the file directly on disk.
    writeFiles(project, { "vendor/file.txt": BASE.replace("line4", "UPSTREAM line4") });
    const reviewed = await pendingOf("vendor/file.txt");
    expect(reviewed.conflictsRemaining).toBe(0);
    expect(reviewed.review!.map((region) => region.status)).toEqual(["upstream"]);

    const reopen = await call("/api/reopen", {
      method: "POST",
      body: JSON.stringify({ path: "vendor/file.txt", index: 0 }),
    });
    expect(reopen.status).toBe(200);
    expect(readFileSync(join(project, "vendor/file.txt"), "utf8")).toContain("<<<<<<<");
    expect((await pendingOf("vendor/file.txt")).review!.map((region) => region.status)).toEqual(["unresolved"]);
  });

  it("rejects reopening a region that is still open", async () => {
    const response = await call("/api/reopen", {
      method: "POST",
      body: JSON.stringify({ path: "vendor/file.txt", index: 0 }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("already open");
  });

  it("opens tracked files with REGRAFT_EDITOR and rejects untracked paths", async () => {
    const previous = process.env.REGRAFT_EDITOR;
    process.env.REGRAFT_EDITOR = "true"; // /usr/bin/true: accepts any args, exits 0
    try {
      const ok = await call("/api/open-editor", {
        method: "POST",
        body: JSON.stringify({ path: "vendor/file.txt", line: 4 }),
      });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { editor: string }).editor).toBe("true");

      const bad = await call("/api/open-editor", {
        method: "POST",
        body: JSON.stringify({ path: "vendor/nope.txt" }),
      });
      expect(bad.status).toBe(400);
    } finally {
      if (previous === undefined) delete process.env.REGRAFT_EDITOR;
      else process.env.REGRAFT_EDITOR = previous;
    }
  });
});
