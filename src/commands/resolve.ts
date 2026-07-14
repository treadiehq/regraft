import { intentHashesByPath } from "../core/classify";
import { hashFileIfExists, readFileIfExists, sha256 } from "../core/hash";
import { requireManifest, saveManifest, type Intent, type Source } from "../core/manifest";
import { hasConflictMarkers } from "../core/merge";
import { writePatchMd } from "../core/patchmd";
import { findRoot, managedFilePath, normalizeUserPath, projectPath } from "../core/workspace";
import { recordIntent } from "./note";

export interface ResolveOptions {
  cwd: string;
  files?: string[];
  note?: string;
}

export interface ResolveResult {
  command: "resolve";
  exitCode: 0 | 1;
  /** Files cleared from unresolved (stored hash updated to disk). */
  resolved: string[];
  /** Files that still contain conflict markers (nothing was changed). */
  markersRemain: string[];
  /** Resolved files whose content is not covered by any intent snapshot. */
  needsNote: string[];
  /** The intent recorded via --note, or null. */
  note: Intent | null;
}

export function resolveCommand(opts: ResolveOptions): ResolveResult {
  const root = findRoot(opts.cwd);
  const manifest = requireManifest(root);

  const unresolvedMap = new Map<string, { source: Source; rel: string }>();
  for (const source of manifest.sources) {
    for (const rel of source.unresolved) {
      unresolvedMap.set(projectPath(source.dest, rel), { source, rel });
    }
  }

  let targets: string[];
  if (opts.files && opts.files.length > 0) {
    targets = opts.files.map(normalizeUserPath);
    for (const t of targets) {
      if (!unresolvedMap.has(t)) {
        const listed = [...unresolvedMap.keys()].join(", ") || "(none)";
        throw new Error(`"${t}" is not marked unresolved. Unresolved files: ${listed}`);
      }
    }
  } else {
    targets = [...unresolvedMap.keys()].sort();
  }

  if (targets.length === 0) {
    return { command: "resolve", exitCode: 0, resolved: [], markersRemain: [], needsNote: [], note: null };
  }

  // Verify every target is marker-free before touching any state.
  const markersRemain: string[] = [];
  const diskHashes = new Map<string, string>();
  for (const t of targets) {
    const buf = readFileIfExists(managedFilePath(root, t));
    if (buf === null) {
      throw new Error(`"${t}" is missing from disk. Restore it (or take upstream with \`regraft pull --force\`) before resolving.`);
    }
    if (hasConflictMarkers(buf)) markersRemain.push(t);
    else diskHashes.set(t, sha256(buf));
  }
  if (markersRemain.length > 0) {
    return { command: "resolve", exitCode: 1, resolved: [], markersRemain, needsNote: [], note: null };
  }

  for (const t of targets) {
    const entry = unresolvedMap.get(t);
    if (!entry) continue;
    entry.source.unresolved = entry.source.unresolved.filter((rel) => rel !== entry.rel);
    entry.source.files[entry.rel] = diskHashes.get(t) as string;
  }

  let note: Intent | null = null;
  let needsNote: string[] = [];
  if (opts.note && opts.note.trim()) {
    const files: Record<string, string> = {};
    for (const t of targets) files[t] = diskHashes.get(t) as string;
    note = recordIntent(manifest, opts.note, files);
  } else {
    const intentHashes = intentHashesByPath(manifest.intents);
    needsNote = targets.filter((t) => {
      const disk = hashFileIfExists(managedFilePath(root, t));
      return disk === null || !intentHashes.get(t)?.has(disk);
    });
  }

  saveManifest(root, manifest);
  writePatchMd(root, manifest);

  return {
    command: "resolve",
    exitCode: needsNote.length > 0 ? 1 : 0,
    resolved: targets,
    markersRemain: [],
    needsNote,
    note,
  };
}
