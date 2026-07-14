import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hashFileIfExists, isBinary, sha256 } from "../core/hash";
import { cleanupTempDirs, makeTempDir } from "./helpers";

afterAll(cleanupTempDirs);

describe("sha256", () => {
  it("matches the known empty-input digest", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("hashes strings and buffers identically", () => {
    expect(sha256("hello")).toBe(sha256(Buffer.from("hello")));
  });
});

describe("hashFileIfExists", () => {
  it("returns null for missing files and a digest for existing ones", () => {
    const dir = makeTempDir();
    expect(hashFileIfExists(join(dir, "nope.txt"))).toBeNull();
    writeFileSync(join(dir, "yes.txt"), "content");
    expect(hashFileIfExists(join(dir, "yes.txt"))).toBe(sha256("content"));
  });

  it.skipIf(process.platform === "win32")("refuses to follow symbolic links", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "target.txt"), "content");
    const link = join(dir, "link.txt");
    symlinkSync("target.txt", link);
    expect(() => hashFileIfExists(link)).toThrow(/symbolic link/);
  });
});

describe("isBinary", () => {
  it("treats NUL bytes as binary", () => {
    expect(isBinary(Buffer.from([0x89, 0x50, 0x00, 0x47]))).toBe(true);
  });

  it("treats plain text as not binary", () => {
    expect(isBinary(Buffer.from("just text\nwith lines\n"))).toBe(false);
  });

  it("only inspects the first 8 KiB", () => {
    const buf = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]);
    expect(isBinary(buf)).toBe(false);
  });
});
