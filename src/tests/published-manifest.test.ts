import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addCommand } from "../commands/add";
import { validateCommand } from "../commands/validate";
import { loadManifest } from "../core/manifest";
import { parsePublishedManifest } from "../core/published-manifest";
import { cleanupTempDirs, initUpstream, makeProject } from "./helpers";

afterAll(cleanupTempDirs);

const VALID = `version: 1
grafts:
  session:
    path: packages/auth/src/session
    description: Session management implementation
`;

describe("publishable regraft.yaml", () => {
  it("parses a strict, versioned manifest", () => {
    expect(parsePublishedManifest(VALID)).toEqual({
      version: 1,
      grafts: {
        session: {
          path: "packages/auth/src/session",
          description: "Session management implementation",
        },
      },
    });
  });

  it("normalizes repository root and rejects unsafe or noncanonical paths", () => {
    expect(
      parsePublishedManifest(`version: 1\ngrafts:\n  root:\n    path: .\n    description: Whole repository\n`).grafts.root!.path,
    ).toBe("");
    for (const path of ["../src", "/src", "src\\\\auth", "src//auth", "src/./auth"]) {
      expect(() =>
        parsePublishedManifest(`version: 1\ngrafts:\n  bad:\n    path: ${JSON.stringify(path)}\n    description: Bad path\n`),
      ).toThrow(/canonical repository-relative/);
    }
  });

  it("rejects duplicate keys, unknown fields, aliases, and unsupported versions", () => {
    expect(() =>
      parsePublishedManifest(`version: 1\ngrafts:\n  one:\n    path: src\n    path: lib\n    description: Duplicate\n`),
    ).toThrow(/valid YAML/);
    expect(() =>
      parsePublishedManifest(`version: 1\nextra: true\ngrafts:\n  one:\n    path: src\n    description: Extra\n`),
    ).toThrow(/Unrecognized key/);
    expect(() =>
      parsePublishedManifest(`version: 1\ngrafts:\n  one: &one\n    path: src\n    description: One\n  two: *one\n`),
    ).toThrow(/alias|aliases/i);
    expect(() =>
      parsePublishedManifest(`version: 1\ngrafts:\n  one:\n    path: !custom src\n    description: Custom tag\n`),
    ).toThrow(/unsupported YAML|tag/i);
    expect(() => parsePublishedManifest(`version: 2\ngrafts: {}\n`)).toThrow(/version/);
  });

  it("resolves explicit and friendly published Graft selectors through Git", () => {
    const upstream = initUpstream({
      "regraft.yaml": VALID,
      "packages/auth/src/session/index.ts": "export const session = true;\n",
    });

    const explicitProject = makeProject();
    const explicit = addCommand(`${upstream.url}#graft=session`, undefined, { cwd: explicitProject });
    expect(explicit.source).toMatchObject({
      name: "session",
      path: "packages/auth/src/session",
      dest: "session",
      publication: { manifestVersion: 1, name: "session" },
    });

    const friendlyProject = makeProject();
    const friendly = addCommand(`${upstream.url}#session`, "src/session", { cwd: friendlyProject });
    expect(friendly.source.path).toBe("packages/auth/src/session");
    expect(loadManifest(friendlyProject)!.grafts[0]!.publication?.description).toBe(
      "Session management implementation",
    );
  });

  it("validates a local manifest for maintainers", () => {
    const project = makeProject();
    writeFileSync(join(project, "regraft.yaml"), VALID);
    const result = validateCommand(undefined, { cwd: project });
    expect(result).toMatchObject({
      command: "validate",
      exitCode: 0,
      version: 1,
      grafts: [{ name: "session", path: "packages/auth/src/session" }],
    });
  });
});
