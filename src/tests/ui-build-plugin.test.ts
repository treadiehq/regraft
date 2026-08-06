import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { build, type Plugin } from "vite";
import { emitAppHtmlModule } from "../../web/build-plugin";
import { cleanupTempDirs, makeTempDir } from "./helpers";

afterAll(cleanupTempDirs);

function fixture(): { root: string; appHtmlModule: string } {
  const root = makeTempDir("regraft-ui-build-");
  writeFileSync(join(root, "index.html"), "<!doctype html><h1>hello</h1>\n");
  return { root, appHtmlModule: join(root, "app-html.ts") };
}

describe("emitAppHtmlModule", () => {
  it("embeds index.html after a successful output write", async () => {
    const { root, appHtmlModule } = fixture();

    await build({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [emitAppHtmlModule(appHtmlModule)],
      build: { outDir: "dist", emptyOutDir: true },
    });

    const generated = readFileSync(appHtmlModule, "utf8");
    expect(generated).toContain("GENERATED FILE");
    expect(generated).toContain("<h1>hello</h1>");
  });

  it("does not mask an earlier bundle-generation failure", async () => {
    const { root, appHtmlModule } = fixture();
    const failingPlugin: Plugin = {
      name: "regraft:test-original-failure",
      generateBundle() {
        throw new Error("original bundle failure");
      },
    };

    await expect(
      build({
        configFile: false,
        root,
        logLevel: "silent",
        plugins: [failingPlugin, emitAppHtmlModule(appHtmlModule)],
        build: { outDir: "dist", emptyOutDir: true },
      }),
    ).rejects.toThrow("original bundle failure");
    expect(existsSync(appHtmlModule)).toBe(false);
  });
});
