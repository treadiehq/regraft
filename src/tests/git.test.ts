import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ensureCacheRepo,
  ensureGitAvailable,
  fetchRef,
  hasCommit,
  listFilesAt,
  logRange,
  pathKind,
  readFileAt,
  resolveRemote,
} from "../core/git";
import { cleanupTempDirs, commitUpstream, initUpstream, makeTempDir } from "./helpers";

afterAll(cleanupTempDirs);

describe("git core", () => {
  it("ensureGitAvailable succeeds when git is on PATH", () => {
    expect(() => ensureGitAvailable()).not.toThrow();
  });

  it("resolveRemote resolves the default branch via HEAD symref", () => {
    const up = initUpstream({ "a.txt": "hello\n" });
    const head = resolveRemote(up.url);
    expect(head).toEqual({ sha: up.sha, ref: "main" });
  });

  it("resolveRemote resolves an explicit branch", () => {
    const up = initUpstream({ "a.txt": "hello\n" });
    expect(resolveRemote(up.url, "main")).toEqual({ sha: up.sha, ref: "main" });
  });

  it("resolveRemote passes through 40-char SHAs", () => {
    const sha = "f".repeat(40);
    expect(resolveRemote("file:///nowhere", sha)).toEqual({ sha, ref: sha });
  });

  it("resolveRemote errors on unknown refs", () => {
    const up = initUpstream({ "a.txt": "hello\n" });
    expect(() => resolveRemote(up.url, "no-such-branch")).toThrow(/not found/);
  });

  it("fetches into a bare cache and reads files, kinds, and logs", () => {
    const up = initUpstream({ "dir/file.txt": "v1\n", "top.txt": "top\n" });
    const v1 = up.sha;
    const v2 = commitUpstream(up, { "dir/file.txt": "v2\n" }, { message: "bump file" });

    const cache = ensureCacheRepo(join(makeTempDir(), "cache"), up.url);
    const tip = fetchRef(cache, up.url, "main");
    expect(tip).toBe(v2);
    expect(hasCommit(cache, v1)).toBe(true); // ancestor came along with the branch fetch

    expect(pathKind(cache, v2, "dir")).toBe("dir");
    expect(pathKind(cache, v2, "dir/file.txt")).toBe("file");
    expect(pathKind(cache, v2, "nope")).toBe("missing");
    expect(pathKind(cache, v2, "")).toBe("dir");

    expect(listFilesAt(cache, v2, "")).toEqual(["dir/file.txt", "top.txt"]);
    expect(listFilesAt(cache, v2, "dir")).toEqual(["file.txt"]);
    expect(listFilesAt(cache, v2, "dir/file.txt")).toEqual([""]);
    expect(listFilesAt(cache, v2, "missing/path")).toEqual([]);

    expect(readFileAt(cache, v1, "dir/file.txt").toString()).toBe("v1\n");
    expect(readFileAt(cache, v2, "dir/file.txt").toString()).toBe("v2\n");

    const log = logRange(cache, v1, v2, "dir");
    expect(log).toContain("bump file");
    expect(logRange(cache, v1, v2, "top.txt")).toBe("");
  });
});
