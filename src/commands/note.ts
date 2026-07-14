import { randomBytes } from "node:crypto";
import { findUnrecordedModifications } from "../core/classify";
import { hashFileIfExists } from "../core/hash";
import { MutationJournal } from "../core/journal";
import {
  MANIFEST_FILE,
  requireManifest,
  saveManifest,
  type Graft,
  type Intent,
  type IntentTarget,
  type Manifest,
} from "../core/manifest";
import { PATCH_MD_FILE, writePatchMd } from "../core/patchmd";
import { findRoot, managedFilePath, normalizeUserPath, projectPath, withWorkspaceLock } from "../core/workspace";

export interface NoteOptions {
  cwd: string;
  files?: string[];
}

export interface NoteResult {
  command: "note";
  exitCode: 0;
  intent: IntentResult;
}

export type IntentResult = Intent & { files: Record<string, string | null> };

interface TrackedEntry {
  graft: Graft;
  rel: string;
}

/** Map every tracked file's project-relative path to its source entry. */
export function trackedFileMap(manifest: Manifest): Map<string, TrackedEntry> {
  const map = new Map<string, TrackedEntry>();
  for (const graft of manifest.grafts) {
    for (const rel of Object.keys(graft.files)) {
      map.set(projectPath(graft.dest, rel), { graft, rel });
    }
  }
  return map;
}

export interface IntentSnapshot {
  graft: Graft;
  rel: string;
  path: string;
  hash: string | null;
}

/** Create Graft-scoped Intent and mark the snapshots as current accepted local state. */
export function recordIntent(manifest: Manifest, description: string, snapshots: IntentSnapshot[]): Intent {
  const targets: IntentTarget[] = snapshots.map((snapshot) => ({
    kind: "graft-file",
    graftId: snapshot.graft.id,
    rel: snapshot.rel,
    path: snapshot.path,
    hash: snapshot.hash,
  }));
  const intent: Intent = {
    id: randomBytes(4).toString("hex"),
    date: new Date().toISOString(),
    description: description.trim(),
    targets,
  };
  manifest.intents.push(intent);
  for (const snapshot of snapshots) {
    const file = snapshot.graft.files[snapshot.rel];
    if (!file) continue;
    file.localHash = snapshot.hash;
    file.intentIds = [...new Set([...file.intentIds, intent.id])];
    file.needsIntent = false;
  }
  return intent;
}

export function presentIntent(intent: Intent): IntentResult {
  return {
    ...intent,
    files: Object.fromEntries(intent.targets.map((target) => [target.path, target.hash])),
  };
}

export function noteCommand(description: string, opts: NoteOptions): NoteResult {
  const root = findRoot(opts.cwd);
  return withWorkspaceLock(root, () => {
    const journal = new MutationJournal(root);
    try {
      return noteCommandUnlocked(description, opts, journal);
    } catch (error) {
      journal.rollback();
      throw error;
    }
  });
}

function noteCommandUnlocked(description: string, opts: NoteOptions, journal: MutationJournal): NoteResult {
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
        const dests = manifest.grafts.map((graft) => graft.dest).join(", ") || "(none)";
        throw new Error(`"${t}" is not a tracked file. Tracked files live under: ${dests}`);
      }
    }
  } else {
    // Default: every tracked file whose disk hash differs from the stored hash
    // and is not already covered by an intent snapshot at its current hash.
    targets = findUnrecordedModifications(root, manifest);
    if (targets.length === 0) {
      throw new Error(
        "Nothing to record: no changed tracked files need a note.\n" +
          "Change a tracked file first, or pass --files to record specific files.",
      );
    }
  }

  const snapshots: IntentSnapshot[] = [];
  for (const t of [...targets].sort()) {
    const disk = hashFileIfExists(managedFilePath(root, t));
    const entry = tracked.get(t);
    if (!entry) throw new Error(`"${t}" is not a tracked file.`);
    snapshots.push({ graft: entry.graft, rel: entry.rel, path: t, hash: disk });
  }

  const intent = recordIntent(manifest, description, snapshots);
  journal.capture(MANIFEST_FILE);
  journal.capture(PATCH_MD_FILE);
  saveManifest(root, manifest);
  writePatchMd(root, manifest);
  return { command: "note", exitCode: 0, intent: presentIntent(intent) };
}
