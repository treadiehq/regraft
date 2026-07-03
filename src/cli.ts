#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { addCliCommand } from "./commands/add";
import { completionCommand } from "./commands/completion";
import { diffCommand } from "./commands/diff";
import { noteCommand } from "./commands/note";
import { pullCommand } from "./commands/pull";
import { removeCommand } from "./commands/remove";
import { resolveCommand } from "./commands/resolve";
import { statusCommand } from "./commands/status";
import { updateCommand } from "./commands/update";
import {
  printAddCli,
  printCompletion,
  printDiff,
  printError,
  printNote,
  printPull,
  printRemove,
  printResolve,
  printStatus,
} from "./ui/output";

/**
 * Resolve the CLI version. Standalone release binaries get `__REGRAFT_VERSION__`
 * baked in at build time (there is no package.json on disk next to a compiled
 * binary); source and dev builds fall back to reading it from package.json.
 */
declare const __REGRAFT_VERSION__: string | undefined;
function resolveVersion(): string {
  if (typeof __REGRAFT_VERSION__ === "string" && __REGRAFT_VERSION__.length > 0) {
    return __REGRAFT_VERSION__;
  }
  try {
    const { version } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    return version;
  } catch {
    return "0.0.0";
  }
}

function execute<T extends { exitCode: number }>(json: boolean, printer: (result: T) => void, fn: () => T): void {
  try {
    const result = fn();
    if (json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else printer(result);
    process.exitCode = result.exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) process.stdout.write(JSON.stringify({ error: message, exitCode: 1 }, null, 2) + "\n");
    else printError(message);
    process.exitCode = 1;
  }
}

const program = new Command();
program
  .name("regraft")
  .description(
    "Vendor files from upstream git repos, customize them, and keep pulling upstream\n" +
      "updates via three-way merge — with plain-English intent notes (PATCH.md) so a\n" +
      "coding agent can reconcile conflicts. Deterministic; never calls a model.",
  )
  .version(resolveVersion())
  .showHelpAfterError();

program
  .command("add")
  .description("Vendor files or directories from upstream git repos and start tracking them")
  .argument("<args...>", "one or more upstream sources, optionally followed by a dest (single source only)")
  .option("--force", "overwrite existing local files that differ from upstream")
  .option("--adopt", "track existing differing files as local modifications instead of skipping them")
  .option("--dry-run", "report what would happen without writing anything")
  .option("--json", "print machine-readable JSON")
  .addHelpText(
    "after",
    `
The last argument is treated as the local destination when it is a plain path
(no URL scheme, no #ref, no /tree/, /blob/, or /pull/ segment). A destination
is only supported with a single source; with several sources each one lands in
its default destination.

--adopt is for code you vendored by hand before using regraft: existing files
that differ from upstream are tracked as-is (nothing is overwritten) and show
up as local modifications — record why with \`regraft note\`.

Examples:
  $ regraft add owner/repo/tree/main/src/components lib/components
  $ regraft add owner/repo/blob/main/src/utils.ts lib/utils.ts
  $ regraft add owner/repo/pull/42
  $ regraft add ownerA/repoA/tree/main/lib ownerB/repoB/tree/main/tools
  $ regraft add owner/repo/tree/main/src/components lib/components --adopt
  $ regraft add "git@github.com:owner/repo.git#main:src/lib" vendor/lib
`,
  )
  .action((args: string[], opts: { force?: boolean; adopt?: boolean; dryRun?: boolean; json?: boolean }) => {
    execute(Boolean(opts.json), printAddCli, () =>
      addCliCommand(args, { cwd: process.cwd(), force: opts.force, adopt: opts.adopt, dryRun: opts.dryRun }),
    );
  });

program
  .command("diff")
  .description("Show local edits vs the vendored baseline, or upstream movement with --upstream")
  .argument("[files...]", "project-relative tracked files to scope to (default: all)")
  .option("--upstream", "diff the pinned upstream content against the current remote head instead")
  .option("--json", "print machine-readable JSON")
  .addHelpText(
    "after",
    `
Exit code 1 when there are differences, 0 when there are none (like git diff).

Examples:
  $ regraft diff
  $ regraft diff lib/components/theme.ts
  $ regraft diff --upstream
`,
  )
  .action((files: string[], opts: { upstream?: boolean; json?: boolean }) => {
    execute(Boolean(opts.json), printDiff, () =>
      diffCommand({ cwd: process.cwd(), files, upstream: opts.upstream }),
    );
  });

program
  .command("note")
  .description("Record the intent behind local customizations of tracked files (updates PATCH.md)")
  .argument("<description>", "plain-English: what was changed and why")
  .option("--files <paths...>", "project-relative files to snapshot (default: all modified tracked files not yet covered)")
  .option("--json", "print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  $ regraft note "Replaced default theme tokens with our brand palette"
  $ regraft note "Added retry logic to the fetch wrapper" --files lib/utils.ts
`,
  )
  .action((description: string, opts: { files?: string[]; json?: boolean }) => {
    execute(Boolean(opts.json), printNote, () => noteCommand(description, { cwd: process.cwd(), files: opts.files }));
  });

program
  .command("status")
  .description("Classify every tracked file and check upstreams for new commits (CI gate; no writes)")
  .option("--offline", "skip upstream checks (no network); classify local state only")
  .option("--json", "print machine-readable JSON")
  .addHelpText(
    "after",
    `
Exit code 1 if anything is stale, unrecorded, missing, or unresolved.
With --offline, staleness is not checked and the exit code reflects local state only.

Examples:
  $ regraft status
  $ regraft status --json
  $ regraft status --offline
`,
  )
  .action((opts: { offline?: boolean; json?: boolean }) => {
    execute(Boolean(opts.json), printStatus, () => statusCommand({ cwd: process.cwd(), offline: opts.offline }));
  });

program
  .command("pull")
  .description("Pull upstream updates: fast-forward clean files, three-way merge modified ones")
  .option("--dry-run", "report what would happen without writing anything")
  .option("--force", "take upstream wholesale for conflicting files instead of writing markers")
  .option("--json", "print machine-readable JSON")
  .addHelpText(
    "after",
    `
On conflict, diff3 markers are written in place and a reconciliation brief is
generated under .regraft/briefs/ with the relevant intents from PATCH.md.

Examples:
  $ regraft pull
  $ regraft pull --dry-run
  $ regraft pull --force
`,
  )
  .action((opts: { dryRun?: boolean; force?: boolean; json?: boolean }) => {
    execute(Boolean(opts.json), printPull, () => pullCommand({ cwd: process.cwd(), dryRun: opts.dryRun, force: opts.force }));
  });

program
  .command("resolve")
  .description("Mark conflicted files as reconciled after fixing them (verifies markers are gone)")
  .argument("[files...]", "project-relative files to resolve (default: all unresolved)")
  .option("--note <description>", "record the resolution intent in the same step")
  .option("--json", "print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  $ regraft resolve --note "Re-applied brand palette on top of upstream's new token system"
  $ regraft resolve lib/components/button.tsx
`,
  )
  .action((files: string[], opts: { note?: string; json?: boolean }) => {
    execute(Boolean(opts.json), printResolve, () => resolveCommand({ cwd: process.cwd(), files, note: opts.note }));
  });

program
  .command("remove")
  .description("Stop tracking a source (substring match on its URL or local dest)")
  .argument("<source>", "substring of the tracked source URL or its local dest path")
  .option("--hard", "also delete the tracked files from disk")
  .option("--json", "print machine-readable JSON")
  .addHelpText(
    "after",
    `
Intent entries are kept as history and marked orphaned in PATCH.md.

Examples:
  $ regraft remove owner/repo
  $ regraft remove lib/components
  $ regraft remove owner/repo --hard
`,
  )
  .action((source: string, opts: { hard?: boolean; json?: boolean }) => {
    execute(Boolean(opts.json), printRemove, () => removeCommand(source, { cwd: process.cwd(), hard: opts.hard }));
  });

program
  .command("update")
  .description("Update regraft itself to the latest release")
  .argument("[version]", "release tag to update to, e.g. v0.2.0 (default: latest)")
  .addHelpText(
    "after",
    `
A standalone binary install re-runs the public installer; a git checkout is
pulled and rebuilt in place; a package-manager install is left to npm/pnpm.

Examples:
  $ regraft update
  $ regraft update v0.2.0
`,
  )
  .action((version?: string) => {
    process.exitCode = updateCommand(version);
  });

program
  .command("completion")
  .description("Print a shell completion script (bash, zsh, or fish)")
  .argument("<shell>", "bash | zsh | fish")
  .option("--json", "print machine-readable JSON")
  .addHelpText(
    "after",
    `
Setup:
  bash:  echo 'eval "$(regraft completion bash)"' >> ~/.bashrc
  zsh:   regraft completion zsh > ~/.zfunc/_regraft     # with fpath+=(~/.zfunc) before compinit
  fish:  regraft completion fish > ~/.config/fish/completions/regraft.fish

Examples:
  $ regraft completion zsh
`,
  )
  .action((shell: string, opts: { json?: boolean }) => {
    execute(Boolean(opts.json), printCompletion, () => completionCommand(shell));
  });

program.parse();
