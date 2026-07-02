import { describe, expect, it } from "vitest";
import { defaultDest, looksLikeSource, parseSourceArg, repoNameFromUrl } from "../core/urls";

describe("parseSourceArg", () => {
  it("parses owner/repo shorthand", () => {
    expect(parseSourceArg("acme/widgets")).toEqual({
      url: "https://github.com/acme/widgets.git",
      path: "",
    });
  });

  it("parses owner/repo#ref shorthand", () => {
    expect(parseSourceArg("acme/widgets#dev")).toEqual({
      url: "https://github.com/acme/widgets.git",
      ref: "dev",
      path: "",
    });
  });

  it("parses owner/repo/tree/<ref>/<path> shorthand", () => {
    expect(parseSourceArg("acme/widgets/tree/main/src/components")).toEqual({
      url: "https://github.com/acme/widgets.git",
      ref: "main",
      path: "src/components",
    });
  });

  it("parses owner/repo/tree/<ref> shorthand with no path", () => {
    expect(parseSourceArg("acme/widgets/tree/v2.1.0")).toEqual({
      url: "https://github.com/acme/widgets.git",
      ref: "v2.1.0",
      path: "",
    });
  });

  it("parses owner/repo/blob/<ref>/<file> shorthand", () => {
    expect(parseSourceArg("acme/widgets/blob/main/src/utils.ts")).toEqual({
      url: "https://github.com/acme/widgets.git",
      ref: "main",
      path: "src/utils.ts",
    });
  });

  it("parses full GitHub repo URLs", () => {
    expect(parseSourceArg("https://github.com/acme/widgets")).toEqual({
      url: "https://github.com/acme/widgets.git",
      path: "",
    });
  });

  it("parses full GitHub tree URLs", () => {
    expect(parseSourceArg("https://github.com/acme/widgets/tree/main/packages/core")).toEqual({
      url: "https://github.com/acme/widgets.git",
      ref: "main",
      path: "packages/core",
    });
  });

  it("parses full GitHub blob URLs", () => {
    expect(parseSourceArg("https://github.com/acme/widgets/blob/develop/README.md")).toEqual({
      url: "https://github.com/acme/widgets.git",
      ref: "develop",
      path: "README.md",
    });
  });

  it("parses git URLs with #ref", () => {
    expect(parseSourceArg("https://git.example.com/team/repo.git#release")).toEqual({
      url: "https://git.example.com/team/repo.git",
      ref: "release",
      path: "",
    });
  });

  it("parses git URLs with #ref:subpath", () => {
    expect(parseSourceArg("https://github.com/acme/widgets.git#v2:packages/core")).toEqual({
      url: "https://github.com/acme/widgets.git",
      ref: "v2",
      path: "packages/core",
    });
  });

  it("parses git URLs with #:subpath (default ref)", () => {
    expect(parseSourceArg("https://git.example.com/team/repo.git#:tools/scripts")).toEqual({
      url: "https://git.example.com/team/repo.git",
      path: "tools/scripts",
    });
  });

  it("parses scp-style git URLs", () => {
    expect(parseSourceArg("git@github.com:acme/widgets.git#main:src")).toEqual({
      url: "git@github.com:acme/widgets.git",
      ref: "main",
      path: "src",
    });
  });

  it("parses file:// URLs with #ref:subpath", () => {
    expect(parseSourceArg("file:///tmp/fixture#main:lib/util")).toEqual({
      url: "file:///tmp/fixture",
      ref: "main",
      path: "lib/util",
    });
  });

  it("parses plain non-GitHub https URLs as git URLs", () => {
    expect(parseSourceArg("https://gitlab.com/group/proj.git")).toEqual({
      url: "https://gitlab.com/group/proj.git",
      path: "",
    });
  });

  it("normalizes leading/trailing slashes in subpaths", () => {
    expect(parseSourceArg("file:///tmp/fixture#main:/lib/util/").path).toBe("lib/util");
  });

  it("rejects empty input", () => {
    expect(() => parseSourceArg("  ")).toThrow(/must not be empty/);
  });

  it("rejects unrecognized input", () => {
    expect(() => parseSourceArg("not a source at all !!!")).toThrow(/Unrecognized source/);
  });

  it("rejects GitHub URLs with only an owner", () => {
    expect(() => parseSourceArg("https://github.com/justowner")).toThrow(/owner\/repo/);
  });

  it("parses owner/repo/pull/<n> shorthand as the PR head ref", () => {
    expect(parseSourceArg("acme/widgets/pull/42")).toEqual({
      url: "https://github.com/acme/widgets.git",
      ref: "pull/42/head",
      path: "",
    });
  });

  it("parses full GitHub PR URLs as the PR head ref", () => {
    expect(parseSourceArg("https://github.com/acme/widgets/pull/7")).toEqual({
      url: "https://github.com/acme/widgets.git",
      ref: "pull/7/head",
      path: "",
    });
  });

  it("rejects non-numeric PR segments", () => {
    expect(() => parseSourceArg("https://github.com/acme/widgets/pull/abc")).toThrow(/Unsupported GitHub URL form/);
  });
});

describe("looksLikeSource", () => {
  it("recognizes URLs, scp remotes, fragments, and tree/blob/pull shorthands", () => {
    expect(looksLikeSource("https://github.com/acme/widgets")).toBe(true);
    expect(looksLikeSource("git@github.com:acme/widgets.git")).toBe(true);
    expect(looksLikeSource("acme/widgets#dev")).toBe(true);
    expect(looksLikeSource("acme/widgets/tree/main/src")).toBe(true);
    expect(looksLikeSource("acme/widgets/blob/main/a.ts")).toBe(true);
    expect(looksLikeSource("acme/widgets/pull/42")).toBe(true);
  });

  it("treats plain relative paths as dests", () => {
    expect(looksLikeSource("lib/components")).toBe(false);
    expect(looksLikeSource("vendor/lib")).toBe(false);
    expect(looksLikeSource("lib/utils.ts")).toBe(false);
  });
});

describe("defaultDest / repoNameFromUrl", () => {
  it("uses the repo name for repo roots", () => {
    expect(defaultDest(parseSourceArg("acme/widgets"))).toBe("widgets");
    expect(defaultDest(parseSourceArg("git@github.com:acme/widgets.git"))).toBe("widgets");
  });

  it("uses the basename of the subpath", () => {
    expect(defaultDest(parseSourceArg("acme/widgets/tree/main/src/components"))).toBe("components");
    expect(defaultDest(parseSourceArg("acme/widgets/blob/main/src/utils.ts"))).toBe("utils.ts");
  });

  it("strips .git from repo names", () => {
    expect(repoNameFromUrl("https://github.com/acme/widgets.git")).toBe("widgets");
    expect(repoNameFromUrl("file:///tmp/some-repo")).toBe("some-repo");
  });
});
