export type CompletionShell = "bash" | "zsh" | "fish";

export const COMPLETION_SHELLS: readonly CompletionShell[] = ["bash", "zsh", "fish"];

interface CommandSpec {
  name: string;
  description: string;
  options: string[];
}

const COMMANDS: readonly CommandSpec[] = [
  { name: "add", description: "Create a Graft from a git source", options: ["--name", "--force", "--adopt", "--dry-run", "--json"] },
  { name: "diff", description: "Show local changes, or upstream changes", options: ["--graft", "--upstream", "--json"] },
  { name: "note", description: "Record why you changed tracked files", options: ["--files", "--json"] },
  { name: "status", description: "Check tracked files and upstream updates", options: ["--offline", "--json"] },
  { name: "pull", description: "Pull upstream Updates into Grafts", options: ["--dry-run", "--force", "--json"] },
  { name: "resolve", description: "Finish pending Graft judgment", options: ["--graft", "--note", "--json"] },
  { name: "inspect", description: "Inspect Graft provenance and context", options: ["--offline", "--json"] },
  { name: "remove", description: "Stop tracking a Graft", options: ["--hard", "--json"] },
  { name: "validate", description: "Validate a publishable regraft.yaml", options: ["--json"] },
  { name: "update", description: "Update regraft itself to the latest release", options: [] },
  { name: "completion", description: "Print a shell completion script", options: ["--json"] },
];

function optionWords(c: CommandSpec): string[] {
  return c.name === "completion" ? [...COMPLETION_SHELLS, ...c.options, "--help"] : [...c.options, "--help"];
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
