import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddManyResult, AddResult } from "../commands/add";
import type { StatusResult } from "../commands/status";
import { printAdd, printAddCli, printStatus } from "../ui/output";

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

function renderMany(value: AddManyResult): string {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  printAddCli(value);
  return chunks.join("");
}

function statusResult(files: StatusResult["sources"][number]["files"]): StatusResult {
  return {
    command: "status",
    exitCode: 1,
    offline: false,
    clean: false,
    stale: false,
    drifted: true,
    sources: [
      {
        id: "g_0123456789abcdef",
        name: "lib",
        url: "https://github.com/acme/lib.git",
        remoteRef: "main",
        path: "src",
        dest: "vendor",
        pinnedSha: "a".repeat(40),
        upstreamSha: "a".repeat(40),
        stale: false,
        files,
      },
    ],
  };
}

function renderStatus(value: StatusResult): string {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  printStatus(value);
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

  it("uses prospective wording for files and counts during dry run", () => {
    const output = render(
      result({
        dryRun: true,
        written: ["vendor/new.ts"],
        identical: [],
      }),
    );
    expect(output).toContain("[dry-run] Would add Graft");
    expect(output).toContain("would write vendor/new.ts");
    expect(output).toContain("1 would be written");
    expect(output).not.toContain("wrote");
    expect(output).not.toContain("1 written");
  });

  it("does not claim adopted files were tracked during dry run", () => {
    const output = render(
      result({
        dryRun: true,
        identical: [],
        adopted: ["vendor/local.ts"],
      }),
    );
    expect(output).toContain("would keep");
    expect(output).toContain("vendor/local.ts (your version; would be tracked as a local change)");
    expect(output).toContain("1 would be kept");
    expect(output).not.toContain("(kept your version; tracked as a local change)");
  });

  it("describes skipped dry-run files and failed Grafts prospectively", () => {
    const output = render(
      result({
        dryRun: true,
        exitCode: 1,
        identical: [],
        skipped: [{ path: "vendor/existing.ts", reason: "existing content differs" }],
      }),
    );
    expect(output).toContain("[dry-run] Would not add Graft");
    expect(output).toContain("would skip  vendor/existing.ts");
    expect(output).toContain("1 would be skipped");
  });

  it("does not claim multiple dry-run sources were added", () => {
    const first = result({ dryRun: true, written: ["lib/a.ts"], identical: [] });
    const second = result({
      dryRun: true,
      written: ["tools/b.ts"],
      identical: [],
      source: { ...result().source, id: "g_fedcba9876543210", name: "tools", dest: "tools" },
    });
    const output = renderMany({ command: "add", exitCode: 0, dryRun: true, results: [first, second] });
    expect(output).toContain("[dry-run] 2 sources would be added.");
    expect(output).not.toContain("2 sources added.");
  });
});

describe("printStatus", () => {
  it.each([
    [1, "1 missing file"],
    [2, "2 missing files"],
  ])("summarizes %i missing tracked files", (count, expected) => {
    const files = Array.from({ length: count }, (_, index) => ({
      path: `vendor/missing-${index}.ts`,
      status: "missing" as const,
    }));
    expect(renderStatus(statusResult(files))).toContain(expected);
  });

  it("prioritizes pending judgment over missing files", () => {
    const output = renderStatus(
      statusResult([
        { path: "vendor/conflict.ts", status: "conflict-unresolved" },
        { path: "vendor/missing.ts", status: "missing" },
      ]),
    );
    expect(output).toContain("1 pending judgment");
    expect(output).not.toContain("1 missing file");
  });

  it("prioritizes missing files over unrecorded changes", () => {
    const output = renderStatus(
      statusResult([
        { path: "vendor/missing.ts", status: "missing" },
        { path: "vendor/changed.ts", status: "modified-unrecorded" },
      ]),
    );
    expect(output).toContain("1 missing file");
    expect(output).not.toContain("1 unrecorded change");
  });
});
