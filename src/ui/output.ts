import type { AddManyResult, AddResult } from "../commands/add";
import type { CompletionResult } from "../commands/completion";
import type { DiffResult } from "../commands/diff";
import type { InspectResult } from "../commands/inspect";
import type { NoteResult } from "../commands/note";
import type { PullResult, PullSourceResult } from "../commands/pull";
import type { RemoveResult } from "../commands/remove";
import type { ResolveResult } from "../commands/resolve";
import type { StatusResult } from "../commands/status";
import type { ValidateResult } from "../commands/validate";
import type { FileStatus } from "../core/classify";

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(code: string, s: string): string {
  return useColor ? `\u001b[${code}m${s}\u001b[0m` : s;
}

const red = (s: string): string => paint("31", s);
const green = (s: string): string => paint("32", s);
const yellow = (s: string): string => paint("33", s);
const bold = (s: string): string => paint("1", s);
const dim = (s: string): string => paint("2", s);

function short(sha: string): string {
  return sha.slice(0, 7);
}

function out(line = ""): void {
  process.stdout.write(line + "\n");
}

export function printError(message: string): void {
  process.stderr.write(`${red("error:")} ${message}\n`);
}

export function printAdd(r: AddResult): void {
  const prefix = r.dryRun ? dim("[dry-run] ") : "";
  if (r.alreadyTracked) {
    out(`${prefix}Graft "${r.source.name}" already tracks ${r.source.url}${r.source.path ? ` (path ${r.source.path})` : ""} → ${r.source.dest}. Nothing to do.`);
    return;
  }
  const label = r.exitCode === 1 ? "Graft not created" : "Added Graft";
  out(
    `${prefix}${bold(label)} ${r.source.name} ${dim(`[${r.source.id}]`)}\n` +
      `  ${r.source.url}${r.source.path ? ` #${r.source.path}` : ""} (${r.source.remoteRef}) at ${short(r.source.pinnedSha)} → ${r.source.dest}`,
  );
  for (const p of r.written) out(`  ${green("wrote")}     ${p}`);
  for (const p of r.identical) out(`  ${dim("identical")} ${p} (tracked without writing)`);
  for (const p of r.adopted) out(`  ${yellow("kept")}      ${p} (kept your version; tracked as a local change)`);
  for (const s of r.skipped) out(`  ${yellow("skipped")}   ${s.path}: ${s.reason}`);
  const counts = [`${r.written.length} written`, `${r.identical.length} identical`];
  if (r.adopted.length > 0) counts.push(`${r.adopted.length} kept`);
  counts.push(`${r.skipped.length} skipped`);
  out(`${prefix}${counts.join(", ")}.`);
  if (!r.dryRun && r.skipped.length > 0) {
    out(yellow("Graft state was not created because some files were skipped."));
    out(dim("Retry the same add with --adopt to keep local files or --force to take upstream."));
  } else if (!r.dryRun && r.adopted.length > 0) {
    out(dim(`Next: record why the adopted files differ: \`regraft note "<what and why>" --files ${r.adopted.join(" ")}\`.`));
  } else if (!r.dryRun && r.skipped.length === 0) {
    out(dim('Next: customize freely, then record why with `regraft note "<what and why>"`.'));
  }
}

export function printAddCli(r: AddResult | AddManyResult): void {
  if (!("results" in r)) {
    printAdd(r);
    return;
  }
  for (const item of r.results) {
    printAdd(item);
    out();
  }
  const failed = r.results.filter((x) => x.exitCode === 1).length;
  out(
    failed > 0
      ? yellow(`${r.results.length} sources processed, ${failed} with skipped files.`)
      : green(`${r.results.length} sources added.`),
  );
}

export function printDiff(r: DiffResult): void {
  let any = false;
  for (const s of r.sources) {
    if (s.files.length === 0) continue;
    any = true;
    const range = r.upstream && s.upstreamSha ? `${short(s.pinnedSha)} → ${short(s.upstreamSha)}` : short(s.pinnedSha);
    out(`${bold(s.name)} ${dim(`[${s.id}]`)} · ${s.url}${s.path ? ` #${s.path}` : ""} (${s.remoteRef}) ${dim(range)}`);
    for (const f of s.files) {
      if (f.diff) {
        out(f.diff.trimEnd());
      } else {
        out(`${yellow(f.change)} ${f.path}${f.note ? dim(` — ${f.note}`) : ""}`);
      }
    }
    out();
  }
  if (!any) {
    out(green(r.upstream ? "No upstream changes since the pinned commits." : "No local changes."));
  }
}

export function printNote(r: NoteResult): void {
  out(`${bold("Recorded Intent")} ${r.intent.id} (${r.intent.date.slice(0, 10)}):`);
  out(`  ${r.intent.description}`);
  for (const target of r.intent.targets) out(`  ${green("snapshot")} ${target.path}`);
  out(dim("PATCH.md regenerated."));
}

const STATUS_COLOR: Record<FileStatus, (s: string) => string> = {
  clean: green,
  "modified+intent": (s) => s,
  "modified-unrecorded": yellow,
  missing: red,
  "conflict-unresolved": red,
  "reconciliation-pending": yellow,
};

export function printStatus(r: StatusResult): void {
  if (r.sources.length === 0) {
    out("No Grafts tracked. Create one with `regraft add <source> [dest]`.");
    return;
  }
  const nameWidth = Math.max("NAME".length, ...r.sources.map((source) => source.name.length));
  const sourceWidth = Math.max(
    "SOURCE".length,
    ...r.sources.map((source) => `${source.url.replace(/^https?:\/\/|\.git$/g, "")}${source.path ? `/${source.path}` : ""}`.length),
  );
  out(`${bold("NAME".padEnd(nameWidth))}  ${bold("SOURCE".padEnd(sourceWidth))}  ${bold("STATUS")}`);
  for (const source of r.sources) {
    const label = `${source.url.replace(/^https?:\/\/|\.git$/g, "")}${source.path ? `/${source.path}` : ""}`;
    const pending = source.files.filter((file) => file.status === "conflict-unresolved" || file.status === "reconciliation-pending").length;
    const unrecorded = source.files.filter((file) => file.status === "modified-unrecorded").length;
    const adapted = source.files.filter((file) => file.status === "modified+intent").length;
    const status =
      pending > 0
        ? `${pending} pending judgment`
        : unrecorded > 0
          ? `${unrecorded} unrecorded change${unrecorded === 1 ? "" : "s"}`
          : source.stale
            ? "update available"
            : adapted > 0
              ? "locally adapted"
              : source.stale === null
                ? "upstream unchecked"
                : "up to date";
    out(`${source.name.padEnd(nameWidth)}  ${label.padEnd(sourceWidth)}  ${status}`);
  }
  out();
  const width = Math.max(...Object.keys(STATUS_COLOR).map((s) => s.length));
  for (const s of r.sources) {
    const staleness =
      s.stale === null
        ? dim("offline — staleness not checked")
        : s.stale && s.upstreamSha
          ? yellow(`STALE — upstream at ${short(s.upstreamSha)} (run \`regraft pull\`)`)
          : green("up to date");
    out(`${bold(s.name)} ${dim(`[${s.id}]`)} · ${s.url}${s.path ? ` #${s.path}` : ""} (${s.remoteRef}) → ${s.dest}`);
    out(`  pinned ${short(s.pinnedSha)} · ${staleness}`);
    const noisy = s.files.filter((f) => f.status !== "clean");
    for (const f of noisy) {
      out(`  ${STATUS_COLOR[f.status](f.status.padEnd(width))} ${f.path}`);
    }
    const cleanCount = s.files.length - noisy.length;
    if (cleanCount > 0) out(dim(`  ${cleanCount} clean file${cleanCount === 1 ? "" : "s"}`));
    out();
  }
  if (r.clean) {
    out(green(r.offline ? "Everything clean locally (upstreams not checked)." : "Everything clean and up to date."));
    return;
  }
  const problems: string[] = [];
  if (r.stale) problems.push("stale sources (run `regraft pull`)");
  const statuses = new Set(r.sources.flatMap((s) => s.files.map((f) => f.status)));
  if (statuses.has("modified-unrecorded")) problems.push('unrecorded local changes (run `regraft note "<why>"`)');
  if (statuses.has("conflict-unresolved")) problems.push("unresolved conflicts (fix markers, then `regraft resolve`)");
  if (statuses.has("reconciliation-pending")) problems.push("updates requiring judgment (run `regraft resolve` or inspect the Brief)");
  if (statuses.has("missing")) problems.push("missing files");
  if (problems.length > 0) out(`${yellow("Attention:")} ${problems.join("; ")}.`);
  else out(dim("Local changes present, all covered by notes."));
}

function printPullSource(s: PullSourceResult, dry: boolean): void {
  if (s.upToDate) {
    out(`${bold(s.name)} ${dim(`[${s.id}]`)}: already at ${short(s.oldSha)} — up to date.`);
    return;
  }
  out(`${bold(s.name)} ${dim(`[${s.id}]`)} · ${s.url} (${s.remoteRef}): ${short(s.oldSha)} → ${short(s.newSha)}`);
  const verb = dry ? "would " : "";
  for (const p of s.added) out(`  ${green(`${verb}add`.padEnd(14))} ${p}`);
  for (const p of s.fastForwarded) out(`  ${green(`${verb}fast-forward`.padEnd(14))} ${p}`);
  for (const p of s.merged) out(`  ${green(`${verb}merge`.padEnd(14))} ${p}`);
  for (const p of s.forced) out(`  ${yellow(`${verb}force`.padEnd(14))} ${p} (used upstream; local changes discarded)`);
  for (const p of s.deleted) out(`  ${yellow(`${verb}delete`.padEnd(14))} ${p}`);
  for (const p of s.conflicts) out(`  ${red("CONFLICT".padEnd(14))} ${p}`);
  for (const k of s.skipped) out(`  ${dim("skip".padEnd(14))} ${k.path}: ${k.reason}`);
  for (const w of s.warnings) out(`  ${yellow("warning".padEnd(14))} ${w.path}: ${w.message}`);
}

export function printPull(r: PullResult): void {
  if (r.dryRun) out(dim("[dry-run] No files, manifest entries, or briefs will be written."));
  for (const s of r.sources) {
    printPullSource(s, r.dryRun);
    out();
  }
  if (r.unrecordedModifications.length > 0) {
    const n = r.unrecordedModifications.length;
    out(yellow(`Heads-up: ${n} modified tracked file${n === 1 ? " has" : "s have"} no recorded intent:`));
    for (const p of r.unrecordedModifications) out(`  ${p}`);
    out("If these ever conflict, the brief cannot explain why they changed. Record it:");
    out(`  regraft note "<what and why>" --files ${r.unrecordedModifications.join(" ")}`);
    out();
  }
  const conflictCount = r.sources.reduce((n, s) => n + s.conflicts.length, 0);
  const warningCount = r.sources.reduce((n, s) => n + s.warnings.length, 0);
  if (conflictCount === 0 && warningCount === 0) {
    out(green(r.sources.every((s) => s.upToDate) ? "All Grafts up to date." : "Pull complete — no pending judgment."));
    return;
  }
  out(red(`${conflictCount} conflict${conflictCount === 1 ? "" : "s"}, ${warningCount} warning${warningCount === 1 ? "" : "s"}.`));
  if (r.brief) {
    out();
    out(bold("Conflict brief written to:"));
    out(bold(`  ${r.brief}`));
    out();
    out('Next: read the brief, fix each conflict, then run `regraft resolve --note "<how>"`.');
  } else if (r.dryRun) {
    out(dim("A conflict brief would be generated (run without --dry-run)."));
  }
}

export function printResolve(r: ResolveResult): void {
  if (r.markersRemain.length > 0) {
    out(red("Conflict markers still present — nothing resolved:"));
    for (const p of r.markersRemain) out(`  ${p}`);
    out("Remove all `<<<<<<<` / `|||||||` / `>>>>>>>` markers, then re-run `regraft resolve`.");
    return;
  }
  if (r.resolved.length === 0) {
    out("Nothing to resolve — no unresolved conflicts.");
    return;
  }
  for (const p of r.resolved) out(`  ${green("resolved")} ${p}`);
  if (r.note) {
    out(`${bold("Recorded note")} ${r.note.id}: ${r.note.description}`);
  }
  if (r.needsNote.length > 0) {
    out();
    out(`${green("Conflicts resolved")} — files are unlocked for future pulls.`);
    out(yellow("One step left") + " — record why, so PATCH.md stays useful (this command exits 1 until then):");
    out(`  regraft note "<how the conflicts were fixed>" --files ${r.needsNote.join(" ")}`);
    out(dim('Tip: next time, `regraft resolve --note "<why>"` does both in one step.'));
  } else {
    out(green("All resolved files are covered by notes."));
  }
}

export function printCompletion(r: CompletionResult): void {
  process.stdout.write(r.script);
}

export function printRemove(r: RemoveResult): void {
  out(`${bold("Removed Graft")} ${r.removed.name} ${dim(`[${r.removed.id}]`)} · ${r.removed.url}${r.removed.path ? ` #${r.removed.path}` : ""} → ${r.removed.dest}.`);
  for (const p of r.deletedFiles) out(`  ${yellow("deleted")} ${p}`);
  if (!r.hard) out(dim("Files were left on disk (use --hard to also delete them)."));
  out(dim("Notes were kept as history; orphaned ones are marked in PATCH.md."));
}

export function printInspect(result: InspectResult): void {
  for (const graft of result.grafts) {
    out(`${bold(graft.name)} ${dim(`[${graft.id}]`)}`);
    out(`  Source:      ${graft.source.repository}${graft.source.path ? ` #${graft.source.path}` : ""} (${graft.source.remoteRef})`);
    out(`  Pinned:      ${graft.source.pinnedRevision}`);
    out(`  Destination: ${graft.destination}`);
    out(
      `  Upstream:    ${
        graft.upstream.updateAvailable === null
          ? "not checked"
          : graft.upstream.updateAvailable
            ? `update available at ${short(graft.upstream.revision ?? "")}`
            : "up to date"
      }`,
    );
    out(`  Local:       ${graft.local.files.length} files${graft.local.needsAttention ? ", needs attention" : ""}`);
    if (graft.intent.length > 0) {
      out("  Intent:");
      for (const intent of graft.intent) out(`    ${intent.id}  ${intent.description}`);
    }
    if (graft.updates.pending.length > 0) {
      out("  Pending judgment:");
      for (const update of graft.updates.pending) out(`    ${update.kind.padEnd(22)} ${update.path}`);
    }
    for (const brief of graft.briefs) out(`  Brief:       ${brief}`);
    out();
  }
}

export function printValidate(result: ValidateResult): void {
  out(`${green("Valid")} ${result.file} · manifest version ${result.version}`);
  for (const graft of result.grafts) out(`  ${bold(graft.name)}  ${graft.path} — ${graft.description}`);
}
