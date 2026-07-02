import { describe, expect, it } from "vitest";
import { completionCommand } from "../commands/completion";
import { COMPLETION_SHELLS, completionScript } from "../core/completion";

const ALL_COMMANDS = ["add", "diff", "note", "status", "pull", "resolve", "remove", "completion"];

describe("regraft completion", () => {
  it.each(COMPLETION_SHELLS)("generates a %s script covering every command", (shell) => {
    const script = completionScript(shell);
    for (const cmd of ALL_COMMANDS) expect(script).toContain(cmd);
    expect(script).toContain("regraft");
    expect(script).toContain("Setup");
  });

  it("includes per-command flags", () => {
    expect(completionScript("bash")).toContain("--offline");
    expect(completionScript("zsh")).toContain("--dry-run");
    expect(completionScript("fish")).toContain("-l hard");
  });

  it("rejects unsupported shells with the supported list", () => {
    expect(() => completionScript("powershell")).toThrow(/Supported: bash, zsh, fish/);
  });

  it("returns a stable --json shape", () => {
    const result = completionCommand("bash");
    expect(Object.keys(result).sort()).toEqual(["command", "exitCode", "script", "shell"].sort());
    expect(result.exitCode).toBe(0);
    expect(result.shell).toBe("bash");
  });
});
