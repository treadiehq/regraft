export type CompletionShell = "bash" | "zsh" | "fish";

export const COMPLETION_SHELLS: readonly CompletionShell[] = ["bash", "zsh", "fish"];

interface CommandSpec {
  name: string;
  description: string;
  options: string[];
}

const COMMANDS: readonly CommandSpec[] = [
  { name: "add", description: "Vendor files or directories from upstream git repos", options: ["--force", "--adopt", "--dry-run", "--json"] },
  { name: "diff", description: "Show local edits vs the baseline, or upstream movement", options: ["--upstream", "--json"] },
  { name: "note", description: "Record the intent behind local customizations", options: ["--files", "--json"] },
  { name: "status", description: "Classify tracked files and check upstreams for new commits", options: ["--offline", "--json"] },
  { name: "pull", description: "Pull upstream updates via three-way merge", options: ["--dry-run", "--force", "--json"] },
  { name: "resolve", description: "Mark conflicted files as reconciled", options: ["--note", "--json"] },
  { name: "remove", description: "Stop tracking a source", options: ["--hard", "--json"] },
  { name: "update", description: "Update regraft itself to the latest release", options: [] },
  { name: "completion", description: "Print a shell completion script", options: [] },
];

function optionWords(c: CommandSpec): string[] {
  return c.name === "completion" ? [...COMPLETION_SHELLS, "--help"] : [...c.options, "--help"];
}

function bashScript(): string {
  const lines: string[] = [
    "# regraft bash completion",
    "# Setup: add to ~/.bashrc:",
    '#   eval "$(regraft completion bash)"',
    "_regraft_completions() {",
    "  local cur cmd",
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  cmd="${COMP_WORDS[1]}"',
    '  if [ "$COMP_CWORD" -eq 1 ]; then',
    `    COMPREPLY=( $(compgen -W "${COMMANDS.map((c) => c.name).join(" ")} help" -- "$cur") )`,
    "    return 0",
    "  fi",
    '  local opts=""',
    '  case "$cmd" in',
  ];
  for (const c of COMMANDS) {
    lines.push(`    ${c.name}) opts="${optionWords(c).join(" ")}" ;;`);
  }
  lines.push(
    '    *) opts="--help" ;;',
    "  esac",
    '  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )',
    "  return 0",
    "}",
    "complete -o default -F _regraft_completions regraft",
    "",
  );
  return lines.join("\n");
}

function zshScript(): string {
  const lines: string[] = [
    "# regraft zsh completion",
    "# Setup (either):",
    '#   eval "$(regraft completion zsh)"                 # after compinit in ~/.zshrc',
    "#   regraft completion zsh > ~/.zfunc/_regraft       # with fpath+=(~/.zfunc) before compinit",
    "_regraft() {",
    "  local -a cmds",
    "  cmds=(",
  ];
  for (const c of COMMANDS) lines.push(`    '${c.name}:${c.description}'`);
  lines.push(
    "    'help:Show help for a command'",
    "  )",
    "  if (( CURRENT == 2 )); then",
    "    _describe -t commands 'regraft command' cmds",
    "    return",
    "  fi",
    "  local -a opts",
    '  case "$words[2]" in',
  );
  for (const c of COMMANDS) {
    lines.push(`    ${c.name}) opts=(${optionWords(c).join(" ")}) ;;`);
  }
  lines.push(
    "    *) opts=(--help) ;;",
    "  esac",
    "  compadd -- $opts",
    "  _files",
    "}",
    "compdef _regraft regraft",
    "",
  );
  return lines.join("\n");
}

function fishScript(): string {
  const lines: string[] = [
    "# regraft fish completion",
    "# Setup: regraft completion fish > ~/.config/fish/completions/regraft.fish",
  ];
  for (const c of COMMANDS) {
    lines.push(`complete -c regraft -n '__fish_use_subcommand' -a ${c.name} -d '${c.description}'`);
  }
  for (const c of COMMANDS) {
    for (const opt of c.options) {
      lines.push(`complete -c regraft -n '__fish_seen_subcommand_from ${c.name}' -l ${opt.slice(2)}`);
    }
  }
  lines.push(`complete -c regraft -n '__fish_seen_subcommand_from completion' -f -a '${COMPLETION_SHELLS.join(" ")}'`, "");
  return lines.join("\n");
}

export function completionScript(shell: string): string {
  switch (shell) {
    case "bash":
      return bashScript();
    case "zsh":
      return zshScript();
    case "fish":
      return fishScript();
    default:
      throw new Error(`Unsupported shell "${shell}". Supported: ${COMPLETION_SHELLS.join(", ")}.`);
  }
}
