import { writeFileSync } from "node:fs";
import type { Plugin } from "vite";

const BANNER =
  "// GENERATED FILE — do not edit by hand.\n" +
  "// Rebuilt by `pnpm build:ui` (web/ → single self-contained page).\n";

/**
 * After a successful Vite write, wrap the final inlined HTML in a TypeScript
 * module so the CLI and standalone binaries can embed it.
 */
export function emitAppHtmlModule(appHtmlModule: string): Plugin {
  return {
    name: "regraft:emit-app-html-module",
    apply: "build",
    writeBundle(_options, bundle) {
      const output = bundle["index.html"];
      if (output?.type !== "asset") {
        throw new Error("Successful UI build did not emit index.html.");
      }
      const html =
        typeof output.source === "string"
          ? output.source
          : Buffer.from(output.source).toString("utf8");
      writeFileSync(appHtmlModule, `${BANNER}export const APP_HTML = ${JSON.stringify(html)};\n`);
    },
  };
}
