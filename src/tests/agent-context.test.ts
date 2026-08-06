import { describe, expect, it } from "vitest";
import { buildAgentContext } from "../../web/src/lib/agent";
import type { PendingKind, UiFile, UiGraft, UiPending } from "../../web/src/lib/types";

const graft: UiGraft = {
  id: "g_0123456789abcdef",
  name: "lib",
  url: "https://github.com/acme/lib.git",
  remoteRef: "main",
  sourcePath: "src",
  dest: "vendor",
  pinnedSha: "a".repeat(40),
  files: [],
  pendingCount: 1,
};

function pending(kind: PendingKind, overrides: Partial<UiPending> = {}): UiPending {
  return {
    kind,
    headline: `Pending ${kind}`,
    detail: `Review the ${kind} update.`,
    fromSha: "a".repeat(40),
    toSha: "b".repeat(40),
    brief: null,
    binary: kind === "binary-conflict",
    base: "old upstream\n",
    upstream: "new upstream\n",
    local: "local version\n",
    localExact: true,
    working: "local version\n",
    segments: null,
    review: null,
    conflictsRemaining: 0,
    upstreamCommits: [],
    ...overrides,
  };
}

function file(kind: PendingKind, overrides: Partial<UiPending> = {}): UiFile {
  return {
    path: "vendor/file.txt",
    rel: "file.txt",
    status: "reconciliation-pending",
    needsIntent: false,
    intents: [],
    pending: pending(kind, overrides),
  };
}

describe("buildAgentContext", () => {
  it("gives marker-editing instructions for unresolved text regions", () => {
    const prompt = buildAgentContext(
      graft,
      file("content-conflict", {
        segments: [
          {
            type: "conflict",
            index: 0,
            local: "local\n",
            base: "base\n",
            upstream: "upstream\n",
          },
        ],
        conflictsRemaining: 1,
      }),
    );

    expect(prompt).toContain("Unresolved regions are marked inline in diff3 style");
    expect(prompt).toContain("Remove ALL conflict markers");
  });

  it.each([
    ["binary-conflict", "binary file", "keep the local binary"],
    ["upstream-deleted", "Upstream deleted this file", "follow the upstream deletion"],
    ["local-deleted", "deleted locally", "restore the upstream file"],
    ["destination-collision", "claim the same path", "which whole-file version"],
    ["ownership-unknown", "prior ownership", "replace it with upstream"],
  ] satisfies [PendingKind, string, string][])(
    "gives kind-specific guidance for %s",
    (kind, situation, recommendation) => {
      const prompt = buildAgentContext(graft, file(kind));

      expect(prompt).toContain(situation);
      expect(prompt).toContain(recommendation);
      expect(prompt).not.toContain("<<<<<<< local");
      expect(prompt).not.toContain("Remove ALL conflict markers");
    },
  );

  it.each(["content-conflict", "legacy-conflict"] satisfies PendingKind[])(
    "does not invent markers when a %s working file is unavailable",
    (kind) => {
      const prompt = buildAgentContext(graft, file(kind, { working: null, segments: null }));

      expect(prompt).toContain("working file `vendor/file.txt` is unavailable");
      expect(prompt).toContain("Do not recreate or guess");
      expect(prompt).not.toContain("<<<<<<< local");
    },
  );

  it("reviews an already marker-free content resolution without claiming markers remain", () => {
    const prompt = buildAgentContext(
      graft,
      file("content-conflict", {
        segments: [{ type: "text", text: "resolved\n" }],
        working: "resolved\n",
      }),
    );

    expect(prompt).toContain("inline conflict markers have already been removed");
    expect(prompt).toContain("leave the file marker-free");
    expect(prompt).not.toContain("Unresolved regions are marked inline");
  });
});
