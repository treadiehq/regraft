import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddResult } from "../commands/add";
import { printAdd } from "../ui/output";

afterEach(() => vi.restoreAllMocks());

function result(overrides: Partial<AddResult> = {}): AddResult {
  return {
    command: "add",
    exitCode: 0,
    dryRun: false,
    alreadyTracked: false,
    source: {
      id: "g_0123456789abcdef",
      name: "lib",
      url: "https://github.com/acme/lib.git",
      remoteRef: "main",
      path: "src",
      dest: "vendor",
      pinnedSha: "a".repeat(40),
    },
    written: [],
    identical: ["vendor/same.ts"],
    adopted: [],
    skipped: [],
    ...overrides,
  };
}

function render(value: AddResult): string {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  printAdd(value);
  return chunks.join("");
}

describe("printAdd", () => {
  it("reports identical files as tracked after a successful add", () => {
    expect(render(result())).toContain("vendor/same.ts (tracked without writing)");
  });

  it("does not claim identical files were tracked after add rolls back", () => {
    const output = render(
      result({
        exitCode: 1,
        skipped: [{ path: "vendor/diff.ts", reason: "existing content differs" }],
      }),
    );
    expect(output).toContain("vendor/same.ts (matches upstream; not tracked)");
    expect(output).not.toContain("tracked without writing");
  });

  it("describes identical files as planned during a successful dry run", () => {
    expect(render(result({ dryRun: true }))).toContain(
      "vendor/same.ts (matches upstream; would be tracked)",
    );
  });

  it("qualifies the plan when a dry run still has skipped files", () => {
    const output = render(
      result({
        dryRun: true,
        exitCode: 1,
        skipped: [{ path: "vendor/diff.ts", reason: "existing content differs" }],
      }),
    );
    expect(output).toContain(
      "vendor/same.ts (matches upstream; would be tracked after skipped files are resolved)",
    );
  });
});
