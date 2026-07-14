import { resolveGrafts } from "../core/grafts";
import { requireManifest } from "../core/manifest";
import { findRoot, projectPath } from "../core/workspace";
import { diffCommand } from "./diff";
import { statusCommand, type StatusFile } from "./status";

export interface InspectOptions {
  cwd: string;
  grafts?: string[];
  offline?: boolean;
}

export interface InspectIntent {
  id: string;
  date: string;
  description: string;
  files: Record<string, string | null>;
}

export interface InspectGraft {
  id: string;
  name: string;
  source: {
    repository: string;
    remoteRef: string;
    path: string;
    pinnedRevision: string;
    publication: { manifestVersion: 1; name: string; description: string } | null;
  };
  destination: string;
  ownership: "complete" | "legacy-unknown";
  upstream: {
    checked: boolean;
    revision: string | null;
    updateAvailable: boolean | null;
    changedFiles: { path: string; change: "modified" | "missing" | "added" | "deleted"; binary: boolean }[] | null;
  };
  local: {
    clean: boolean;
    needsAttention: boolean;
    files: StatusFile[];
    excludedFiles: string[];
  };
  intent: InspectIntent[];
  updates: {
    pending: {
      path: string;
      kind: string;
      fromRevision: string | null;
      toRevision: string;
      targetKnown: boolean;
      targetHash: string | null;
      observedLocalHash: string | null;
      decision: string;
      brief: string | null;
    }[];
  };
  briefs: string[];
}

export interface InspectResult {
  command: "inspect";
  schemaVersion: 1;
  exitCode: 0 | 1;
  offline: boolean;
  grafts: InspectGraft[];
}

export function inspectCommand(opts: InspectOptions): InspectResult {
  const root = findRoot(opts.cwd);
  const manifest = requireManifest(root);
  const selected = resolveGrafts(manifest, opts.grafts);
  const status = statusCommand({ cwd: root, offline: opts.offline, grafts: selected.map((graft) => graft.id) });
  const byId = new Map(status.sources.map((source) => [source.id, source]));
  const upstreamDiff = opts.offline
    ? null
    : diffCommand({ cwd: root, grafts: selected.map((graft) => graft.id), upstream: true });
  const diffById = new Map(upstreamDiff?.sources.map((source) => [source.id, source]) ?? []);

  const grafts: InspectGraft[] = selected.map((graft) => {
    const graftStatus = byId.get(graft.id)!;
    const pending = Object.entries(graft.files)
      .filter((entry) => entry[1].pending !== null)
      .map(([rel, file]) => ({
        path: projectPath(graft.dest, rel),
        kind: file.pending!.kind,
        fromRevision: file.pending!.fromSha,
        toRevision: file.pending!.toSha,
        targetKnown: file.pending!.targetKnown,
        targetHash: file.pending!.targetHash,
        observedLocalHash: file.pending!.observedLocalHash,
        decision: "Reconcile the local file and run resolve, or explicitly take upstream with pull --force.",
        brief: file.pending!.brief,
      }));
    const activeIntentIds = new Set(Object.values(graft.files).flatMap((file) => file.intentIds));
    const intent: InspectIntent[] = manifest.intents
      .filter((entry) => activeIntentIds.has(entry.id))
      .map((entry) => {
        const targets = entry.targets.filter(
          (target) =>
            target.kind === "graft-file" &&
            target.graftId === graft.id &&
            graft.files[target.rel]?.intentIds.includes(entry.id),
        );
        if (targets.length === 0) return null;
        return {
          id: entry.id,
          date: entry.date,
          description: entry.description,
          files: Object.fromEntries(targets.map((target) => [target.path, target.hash])),
        };
      })
      .filter((entry): entry is InspectIntent => entry !== null);
    const needsAttention = graftStatus.files.some(
      (file) => file.status === "modified-unrecorded" || file.status === "missing" || file.status.includes("pending") || file.status.includes("conflict"),
    );
    return {
      id: graft.id,
      name: graft.name,
      source: {
        repository: graft.url,
        remoteRef: graft.remoteRef,
        path: graft.path,
        pinnedRevision: graft.pinnedSha,
        publication: graft.publication ?? null,
      },
      destination: graft.dest,
      ownership: graft.ownership,
      upstream: {
        checked: graftStatus.stale !== null,
        revision: graftStatus.upstreamSha,
        updateAvailable: graftStatus.stale,
        changedFiles:
          diffById.get(graft.id)?.files.map((file) => ({
            path: file.path,
            change: file.change,
            binary: file.binary,
          })) ?? null,
      },
      local: {
        clean: graftStatus.files.every((file) => file.status === "clean"),
        needsAttention,
        files: graftStatus.files,
        excludedFiles: graft.excluded.map((rel) => projectPath(graft.dest, rel)),
      },
      intent,
      updates: { pending },
      briefs: [...new Set(pending.map((entry) => entry.brief).filter((brief): brief is string => brief !== null))],
    };
  });

  return {
    command: "inspect",
    schemaVersion: 1,
    exitCode: status.exitCode,
    offline: opts.offline ?? false,
    grafts,
  };
}
