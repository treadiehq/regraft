/** Run a command that reports only an exit code, formatting unexpected errors at the CLI boundary. */
export function executeExitCode(fn: () => number, reportError: (message: string) => void): number {
  try {
    return fn();
  } catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
