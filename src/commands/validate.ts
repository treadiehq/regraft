import { resolve } from "node:path";
import {
  loadPublishedManifestFile,
  PUBLISHED_MANIFEST_FILE,
  type PublishedManifest,
} from "../core/published-manifest";

export interface ValidateOptions {
  cwd: string;
}

export interface ValidateResult {
  command: "validate";
  exitCode: 0;
  file: string;
  version: 1;
  grafts: { name: string; path: string; description: string }[];
}

export function validateCommand(file: string | undefined, opts: ValidateOptions): ValidateResult {
  const display = file ?? PUBLISHED_MANIFEST_FILE;
  const absolute = resolve(opts.cwd, display);
  const manifest: PublishedManifest = loadPublishedManifestFile(absolute);
  return {
    command: "validate",
    exitCode: 0,
    file: display,
    version: manifest.version,
    grafts: Object.entries(manifest.grafts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, graft]) => ({ name, path: graft.path || ".", description: graft.description })),
  };
}
