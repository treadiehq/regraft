import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { findUnrecordedModifications } from "../core/classify";
import { hashFileIfExists } from "../core/hash";
import { requireManifest, saveManifest, type Intent, type Manifest, type Source } from "../core/manifest";
import { writePatchMd } from "../core/patchmd";
import { findRoot, normalizeUserPath, projectPath } from "../core/workspace";

export interface NoteOptions {
  cwd: string;
  files?: string[];
}

export interface NoteResult {
  command: "note";
  exitCode: 0;
  intent: Intent;
}

interface TrackedEntry {
  source: Source;
  rel: string;
}

/** Map every tracked file's project-relative path to its source entry. */
export function trackedFileMap(manifest: Manifest): Map<string, TrackedEntry> {
  const map = new Map<string, TrackedEntry>();
  for (const source of manifest.sources) {
    for (const rel of Object.keys(source.files)) {
      map.set(projectPath(source.dest, rel), { source, rel });
    }
  }
  return map;
}

/** Create an intent entry (also used by `resolve --note`). Mutates the manifest. */
export function recordIntent(manifest: Manifest, description: string, files: Record<string, string>): Intent {
  const intent: Intent = {
    id: randomBytes(4).toString("hex"),
    date: new Date().toISOString(),
    description: description.trim(),
    files,
  };
  manifest.intents.push(intent);
  return intent;
}

export function noteCommand(description: string, opts: NoteOptions): NoteResult {
  if (!description || !description.trim()) {
    throw new Error('Description must not be empty. Example: regraft note "Swapped default theme tokens for brand palette"');
  }
  const root = findRoot(opts.cwd);
  const manifest = requireManifest(root);
  const tracked = trackedFileMap(manifest);

  let targets: string[];
  if (opts.files && opts.files.length > 0) {
    targets = opts.files.map(normalizeUserPath);
    for (const t of targets) {
      if (!tracked.has(t)) {
        const dests = manifest.sources.map((s) => s.dest).join(", ") || "(none)";
        throw new Error(`"${t}" is not a tracked file. Tracked files live under: ${dests}`);
      }
    }
  } else {
    // Default: every tracked file whose disk hash differs from the stored hash
    // and is not already covered by an intent snapshot at its current hash.
    targets = findUnrecordedModifications(root, manifest);
    if (targets.length === 0) {
      throw new Error(
        "Nothing to record: no modified tracked files lack intent coverage.\n" +
          "Modify a tracked file first, or pass --files to snapshot specific files explicitly.",
      );
    }
  }

  const files: Record<string, string> = {};
  for (const t of [...targets].sort()) {
    const disk = hashFileIfExists(join(root, t));
    if (disk === null) throw new Error(`"${t}" does not exist on disk; cannot snapshot it.`);
    files[t] = disk;
  }

  const intent = recordIntent(manifest, description, files);
  saveManifest(root, manifest);
  writePatchMd(root, manifest);
  return { command: "note", exitCode: 0, intent };
}
