import type { UiFile, UiGraft } from "./types";

const REVIEWER_HANDOFF =
  "4. Do NOT run `regraft resolve` or make the whole-file decision yourself. Report your recommendation so a reviewer can act in the regraft UI.";

function instructionsFor(file: UiFile, conflictCount: number): string[] {
  const pending = file.pending;
  if (!pending) return ["1. This file has no pending regraft update. No resolution work is required."];

  if (conflictCount > 0) {
    return [
      `1. Open \`${file.path}\`. Unresolved regions are marked inline in diff3 style ` +
        "(`<<<<<<< local`, `||||||| base`, `>>>>>>> upstream`).",
      "2. Rebuild what the recorded intent says the local change must still do on top of the NEW upstream code. Do not blindly keep the local side.",
      "3. Remove ALL conflict markers and save the file.",
      "4. Do NOT run `regraft resolve`. A reviewer will inspect each decision in the regraft UI and accept the result there.",
    ];
  }

  if (pending.kind === "content-conflict" || pending.kind === "legacy-conflict") {
    if (pending.segments === null) {
      return [
        `1. The working file \`${file.path}\` is unavailable, so there are no inline conflict markers to edit.`,
        "2. Do not recreate or guess the missing content.",
        "3. Tell the reviewer to restore an appropriate whole-file version before asking an agent to resolve regions.",
        REVIEWER_HANDOFF,
      ];
    }
    return [
      `1. Open \`${file.path}\`. Its inline conflict markers have already been removed.`,
      "2. Review the current result against the recorded intent and the new upstream change.",
      "3. Edit only if needed, then leave the file marker-free and save it.",
      "4. Do NOT run `regraft resolve`. A reviewer will inspect and accept the result in the regraft UI.",
    ];
  }

  switch (pending.kind) {
    case "binary-conflict":
      return [
        "1. This is a binary file and has no text conflict markers. Do not edit it as text.",
        "2. Review the recorded intent and upstream change metadata.",
        "3. Recommend whether the reviewer should keep the local binary or take the upstream binary.",
        REVIEWER_HANDOFF,
      ];
    case "upstream-deleted":
      return [
        "1. Upstream deleted this file; the local file has no conflict markers.",
        "2. Review the remaining local file and its recorded intent.",
        "3. Recommend whether the reviewer should keep it as a local file or follow the upstream deletion.",
        REVIEWER_HANDOFF,
      ];
    case "local-deleted":
      return [
        "1. The file is deleted locally, while upstream has a newer version. There is no working file with conflict markers.",
        "2. Review the recorded intent and upstream change metadata.",
        "3. Recommend whether the reviewer should keep the deletion or restore the upstream file.",
        REVIEWER_HANDOFF,
      ];
    case "destination-collision":
      return [
        "1. A local file and a newly added upstream file claim the same path; there are no conflict markers.",
        "2. Review the local file, recorded intent, and upstream change metadata.",
        "3. Recommend which whole-file version the reviewer should keep.",
        REVIEWER_HANDOFF,
      ];
    case "ownership-unknown":
      return [
        "1. Regraft cannot determine this file's prior ownership; there are no conflict markers.",
        "2. Review the current file, recorded intent, and upstream provenance.",
        "3. Recommend whether the reviewer should keep the local state or replace it with upstream.",
        REVIEWER_HANDOFF,
      ];
    default:
      return [
        "1. This pending update does not expose editable conflict regions.",
        "2. Do not guess at file changes.",
        "3. Report the situation and ask the reviewer to make the decision in the regraft UI.",
        REVIEWER_HANDOFF,
      ];
  }
}

/**
 * Assemble a self-contained markdown prompt for a coding agent: intent,
 * upstream commits, and every unresolved region with all three sides.
 */
export function buildAgentContext(graft: UiGraft, file: UiFile): string {
  const pending = file.pending;
  const lines: string[] = [];
  lines.push(`# Resolve a regraft update conflict`, "");
  lines.push(`File: \`${file.path}\``);
  lines.push(`Graft: ${graft.name} — ${graft.url} (${graft.remoteRef})`);
  if (pending) {
    lines.push(
      `Update: \`${pending.fromSha?.slice(0, 7) ?? "?"}\` → \`${pending.toSha.slice(0, 7)}\` (${pending.kind})`,
    );
  }
  lines.push("");

  if (file.intents.length > 0) {
    lines.push(`## Recorded intent (why this file was changed locally)`, "");
    for (const intent of file.intents) {
      lines.push(`- ${intent.date.slice(0, 10)}: ${intent.description}`);
    }
    lines.push("");
  } else {
    lines.push(`## Recorded intent`, "", "_None. Infer the purpose of the local changes from the code below._", "");
  }

  if (pending && pending.upstreamCommits.length > 0) {
    lines.push(`## Upstream commits in this update`, "");
    for (const commit of pending.upstreamCommits) lines.push(`- \`${commit.sha}\` ${commit.subject}`);
    lines.push("");
  }

  const conflicts = pending?.segments?.filter((segment) => segment.type === "conflict") ?? [];
  if (conflicts.length > 0) {
    lines.push(`## Unresolved regions (${conflicts.length})`, "");
    for (const region of conflicts) {
      if (region.type !== "conflict") continue;
      lines.push(`### Region ${region.index + 1}`, "");
      lines.push("Your version (local):", "", "```", region.local.trimEnd(), "```", "");
      lines.push("Old upstream (base):", "", "```", region.base.trimEnd(), "```", "");
      lines.push("New upstream:", "", "```", region.upstream.trimEnd(), "```", "");
    }
  } else if (pending) {
    lines.push(`## Situation`, "", pending.headline, "", pending.detail, "");
  }

  lines.push(`## Instructions`, "");
  lines.push(...instructionsFor(file, conflicts.length));
  return lines.join("\n");
}
