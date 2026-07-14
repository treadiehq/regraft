import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveVersion } from "../core/version";
import { cleanupTempDirs, makeTempDir } from "./helpers";

afterAll(cleanupTempDirs);

function packageJsonUrl(content: string): URL {
  const path = join(makeTempDir("regraft-version-"), "package.json");
  writeFileSync(path, content);
  return pathToFileURL(path);
}

describe("resolveVersion", () => {
  it("prefers a non-empty version baked into a release binary", () => {
    expect(resolveVersion("1.2.3", packageJsonUrl('{ "version": "9.9.9" }'))).toBe("1.2.3");
  });

  it("reads a valid version from package.json for source and dev builds", () => {
    expect(resolveVersion(undefined, packageJsonUrl('{ "version": "1.2.3" }'))).toBe("1.2.3");
  });

  it.each([
    ["a missing version", "{}"],
    ["an empty version", '{ "version": "" }'],
    ["a non-string version", '{ "version": 123 }'],
    ["a null document", "null"],
    ["malformed JSON", "{"],
  ])("falls back for %s", (_description, content) => {
    expect(resolveVersion(undefined, packageJsonUrl(content))).toBe("0.0.0");
  });

  it("falls back when package.json cannot be read", () => {
    const missing = pathToFileURL(join(makeTempDir("regraft-version-"), "missing-package.json"));
    expect(resolveVersion(undefined, missing)).toBe("0.0.0");
  });
});
