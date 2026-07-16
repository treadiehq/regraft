#!/usr/bin/env node
import { Command } from "commander";
import { addCliCommand } from "./commands/add";
import { completionCommand } from "./commands/completion";
import { diffCommand } from "./commands/diff";
import { inspectCommand } from "./commands/inspect";
import { noteCommand } from "./commands/note";
import { pullCommand } from "./commands/pull";
import { removeCommand } from "./commands/remove";
import { resolveCommand } from "./commands/resolve";
import { statusCommand } from "./commands/status";
import { updateCommand } from "./commands/update";
import { validateCommand } from "./commands/validate";
import { executeExitCode } from "./core/execute";
import { resolveVersion } from "./core/version";
import {
  printAddCli,
  printCompletion,
  printDiff,
  printError,
  printInspect,
  printNote,
  printPull,
  printRemove,
  printResolve,
  printStatus,
  printValidate,
} from "./ui/output";

/**
 * Resolve the CLI version. Standalone release binaries get `__REGRAFT_VERSION__`
 * baked in at build time (there is no package.json on disk next to a compiled
 * binary); source and dev builds fall back to reading it from package.json.
 */
declare const __REGRAFT_VERSION__: string | undefined;
const bakedVersion = typeof __REGRAFT_VERSION__ === "string" ? __REGRAFT_VERSION__ : undefined;

function execute<T extends { exitCode: number }>(json: boolean, printer: (result: T) => void, fn: () => T): void {
  try {
    const result = fn();
    if (json) process.stdout.write(JSON.stringify({ schemaVersion: 1, ...result }, null, 2) + "\n");
    else printer(result);
    process.exitCode = result.exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) process.stdout.write(JSON.stringify({ schemaVersion: 1, error: message, exitCode: 1 }, null, 2) + "\n");
    else printError(message);
    process.exitCode = 1;
  }
}

const program = new Command();
program
  .name("regraft")
  .description(
    "Keep copied code up to date.\n" +
      "Git tracks code you own. Package managers track dependencies. Regraft\n" +
      "tracks code you derived through durable Grafts.",
  )
  .version(resolveVersion(bakedVersion, new URL("../package.json", import.meta.url)))
  .showHelpAfterError();

program
  .command("add")
  .description("Create Grafts from Git Sources")
  .argument("<args...>", "one or more sources, optionally followed by a destination (single source only)")
  .option("--force", "overwrite existing local files that differ from upstream")
  .option("--adopt", "keep existing local files and track them as local changes")
  .option("--dry-run", "report what would happen without writing anything")
  .option("--name <name>", "assign a stable lowercase Graft name (single source only)")
  .option("--json", "print machine-readable JSON")
  .addHelpText(
    "after",
    `
The last argument is treated as the local destination when it is a plain path
(no URL scheme, no #ref, no /tree/, /blob/, or /pull/ segment). A destination
is only supported with a single source; with several sources each one lands in
its default destination.

--adopt is for code you copied by hand before using regraft: existing files
that differ from upstream are tracked as-is (nothing is overwritten) and show
up as local changes. Record why with \`regraft note\`.

Examples:
  $ regraft add owner/repo#graft=session src/session --name session
  $ regraft add owner/repo/tree/main/src/components lib/components
  $ regraft add owner/repo/blob/main/src/utils.ts lib/utils.ts
  $ regraft add owner/repo/pull/42
  $ regraft add ownerA/repoA/tree/main/lib ownerB/repoB/tree/main/tools
  $ regraft add owner/repo/tree/main/src/components lib/components --adopt
  $ regraft add "git@github.com:owner/repo.git#main:src/lib" vendor/lib
`,
  )
  .action((args: string[], opts: { force?: boolean; adopt?: boolean; dryRun?: boolean; name?: string; json?: boolean }) => {
    execute(Boolean(opts.json), printAddCli, () =>
      addCliCommand(args, {
        cwd: process.cwd(),
        force: opts.force,
        adopt: opts.adopt,
        dryRun: opts.dryRun,
        name: opts.name,
      }),
    );
  });

program
  .command("diff")
  .description("Show local changes, or upstream changes with --upstream")
  .argument("[files...]", "project-relative tracked files to scope to (default: all)")
  .option("--upstream", "diff the pinned upstream content against the current remote head instead")
  .option("-g, --graft <selectors...>", "scope to exact Graft names or IDs")
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
  .action((files: string[], opts: { upstream?: boolean; graft?: string[]; json?: boolean }) => {
    execute(Boolean(opts.json), printDiff, () =>
      diffCommand({ cwd: process.cwd(), files, grafts: opts.graft, upstream: opts.upstream }),
    );
  });

program
  .command("note")
  .description("Record Intent for locally adapted Graft files (updates PATCH.md)")
  .argument("<description>", "what changed and why")
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
  .description("Check Graft files and upstream Updates")
  .option("--offline", "skip upstream checks (no network); check local files only")
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
  .description("Pull upstream Updates into Grafts")
  .argument("[grafts...]", "exact Graft names or IDs (default: all)")
  .option("--dry-run", "report what would happen without writing anything")
  .option("--force", "use upstream for conflicting files instead of writing markers")
  .option("--json", "print machine-readable JSON")
  .addHelpText(
    "after",
    `
On conflict, regraft writes normal markers in place and creates a brief under
.regraft/briefs/ with the relevant notes from PATCH.md.

Examples:
  $ regraft pull
  $ regraft pull --dry-run
  $ regraft pull --force
`,
  )
  .action((grafts: string[], opts: { dryRun?: boolean; force?: boolean; json?: boolean }) => {
    execute(Boolean(opts.json), printPull, () =>
      pullCommand({ cwd: process.cwd(), grafts, dryRun: opts.dryRun, force: opts.force }),
    );
  });

program
  .command("resolve")
  .description("Finish pending Update judgment after reconciling files")
  .argument("[files...]", "project-relative files to resolve (default: all unresolved)")
  .option("-g, --graft <selectors...>", "scope to exact Graft names or IDs")
  .option("--note <description>", "record why the fix was made in the same step")
  .option("--json", "print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  $ regraft resolve --note "Re-applied brand palette on top of upstream's new token system"
  $ regraft resolve lib/components/button.tsx
`,
  )
  .action((files: string[], opts: { graft?: string[]; note?: string; json?: boolean }) => {
    execute(Boolean(opts.json), printResolve, () =>
      resolveCommand({ cwd: process.cwd(), files, grafts: opts.graft, note: opts.note }),
    );
  });

program
  .command("inspect")
  .description("Inspect Graft provenance, Intent, Updates, and Briefs")
  .argument("[grafts...]", "exact Graft names or IDs (default: all)")
  .option("--offline", "skip upstream checks and inspect local state only")
  .option("--json", "print stable machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  $ regraft inspect
  $ regraft inspect auth
  $ regraft inspect auth --json
  $ regraft inspect --offline --json
`,
  )
  .action((grafts: string[], opts: { offline?: boolean; json?: boolean }) => {
    execute(Boolean(opts.json), printInspect, () =>
      inspectCommand({ cwd: process.cwd(), grafts, offline: opts.offline }),
    );
  });

program
  .command("remove")
  .description("Stop tracking a Graft")
  .argument("<selector>", "exact Graft name/ID, or unique Source URL/destination substring")
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
  .command("validate")
  .description("Validate a publishable regraft.yaml manifest")
  .argument("[file]", "manifest path (default: ./regraft.yaml)")
  .option("--json", "print machine-readable JSON")
  .addHelpText(
    "after",
    `
Exits 0 when the manifest is valid and 1 with precise YAML/schema errors otherwise.

Examples:
  $ regraft validate
  $ regraft validate path/to/regraft.yaml
  $ regraft validate --json
`,
  )
  .action((file: string | undefined, opts: { json?: boolean }) => {
    execute(Boolean(opts.json), printValidate, () => validateCommand(file, { cwd: process.cwd() }));
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
    process.exitCode = executeExitCode(() => updateCommand(version), printError);
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

const jsonRequested = process.argv.includes("--json");
if (jsonRequested) {
  const configureJsonErrors = (command: Command): void => {
    command.exitOverride();
    command.configureOutput({ writeErr: () => undefined, outputError: () => undefined });
    for (const child of command.commands) configureJsonErrors(child);
  };
  configureJsonErrors(program);
}
try {
  program.parse();
} catch (error) {
  const code = (error as { code?: string }).code;
  if (code === "commander.helpDisplayed" || code === "commander.version") {
    process.exitCode = 0;
  } else if (jsonRequested) {
    process.stdout.write(
      JSON.stringify(
        {
          schemaVersion: 1,
          error: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        },
        null,
        2,
      ) + "\n",
    );
    process.exitCode = 1;
  } else {
    throw error;
  }
}
