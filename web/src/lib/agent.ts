import type { UiFile, UiGraft } from "./types";

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
  lines.push(
    `1. Open \`${file.path}\`. Unresolved regions are marked inline in diff3 style ` +
      "(`<<<<<<< local`, `||||||| base`, `>>>>>>> upstream`).",
    "2. Rebuild what the recorded intent says the local change must still do on top of the NEW upstream code. Do not blindly keep the local side.",
    "3. Remove ALL conflict markers and save the file.",
    "4. Do NOT run `regraft resolve`. A reviewer will inspect each decision in the regraft UI and accept the result there.",
  );
  return lines.join("\n");
}
