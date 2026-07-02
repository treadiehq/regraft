import { completionScript, type CompletionShell } from "../core/completion";

export interface CompletionResult {
  command: "completion";
  exitCode: 0;
  shell: CompletionShell;
  script: string;
}

export function completionCommand(shell: string): CompletionResult {
  const script = completionScript(shell);
  return { command: "completion", exitCode: 0, shell: shell as CompletionShell, script };
}
