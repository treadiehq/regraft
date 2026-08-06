import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { emitAppHtmlModule } from "./build-plugin.ts";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const appHtmlModule = fileURLToPath(new URL("../src/ui/app-html.ts", import.meta.url));

/**
 * Inline public/favicon.ico as a data URI. The CLI serves exactly one HTML
 * page, so the icon must live inside it rather than as a separate asset.
 * (The file is PNG data despite its .ico name.)
 */
function inlineFavicon(): Plugin {
  return {
    name: "regraft:inline-favicon",
    transformIndexHtml() {
      const icon = readFileSync(`${webRoot}public/favicon.ico`).toString("base64");
      return [
        {
          tag: "link",
          attrs: { rel: "icon", type: "image/png", href: `data:image/png;base64,${icon}` },
          injectTo: "head",
        },
      ];
    },
  };
}

export default defineConfig({
  root: webRoot,
  plugins: [vue(), tailwindcss(), inlineFavicon(), viteSingleFile(), emitAppHtmlModule(appHtmlModule)],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
    // Everything must live inside the single HTML file, images included.
    assetsInlineLimit: 1024 * 1024,
  },
  server: {
    // Local development against a running `regraft ui --no-open` server:
    //   REGRAFT_UI_TARGET=http://127.0.0.1:<port> pnpm dev:ui
    // then open the dev URL with ?token=<token> appended.
    proxy: process.env.REGRAFT_UI_TARGET
      ? { "/api": { target: process.env.REGRAFT_UI_TARGET, changeOrigin: false } }
      : undefined,
  },
});
