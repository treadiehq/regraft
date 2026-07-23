#!/usr/bin/env node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const cwd = process.cwd();
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "regraft-maintain-"));
const resultFile = process.env.REGRAFT_RESULT_FILE
  ? resolve(cwd, process.env.REGRAFT_RESULT_FILE)
  : resolve(temporaryDirectory, "result.json");
const branchPrefix = Object.hasOwn(process.env, "REGRAFT_BRANCH_PREFIX")
  ? process.env.REGRAFT_BRANCH_PREFIX
  : "regraft/";
const maximumRounds = Number.parseInt(process.env.REGRAFT_MAX_ROUNDS ?? "3", 10);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function runGit(args) {
  const result = run("git", args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function runGitRaw(args) {
  const result = run("git", args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function changedPaths() {
  const tracked = runGitRaw(["diff", "--name-only", "-z", "HEAD"]).split("\0").filter(Boolean);
  const untracked = runGitRaw(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  return [...new Set([...tracked, ...untracked])];
}

function regraftInvocation(args) {
  const configured = process.env.REGRAFT_BIN ?? "regraft";
  if (configured.endsWith(".js")) {
    const script = isAbsolute(configured) ? configured : resolve(cwd, configured);
    return { command: process.execPath, args: [script, ...args] };
  }
  return { command: configured, args };
}

function runRegraft(args) {
  const invocation = regraftInvocation([...args, "--json"]);
  const result = run(invocation.command, invocation.args);
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `regraft ${args.join(" ")} did not return JSON (exit ${result.status}): ${(result.stderr || result.stdout).trim()}`,
    );
  }
  if (payload.error) throw new Error(`regraft ${args.join(" ")} failed: ${payload.error}`);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`regraft ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
  }
  return payload;
}

function inspect(offline = false) {
  return runRegraft(["inspect", ...(offline ? ["--offline"] : [])]);
}

function pendingEntries(inspection) {
  return inspection.grafts.flatMap((graft) =>
    graft.updates.pending.map((pending) => ({
      graft: graft.name,
      ...pending,
    })),
  );
}

function unrecordedEntries(inspection) {
  const failing = new Set(["modified-unrecorded", "missing"]);
  return inspection.grafts.flatMap((graft) =>
    graft.local.files
      .filter((file) => failing.has(file.status))
      .map((file) => ({ graft: graft.name, ...file })),
  );
}

function updateAvailable(inspection) {
  return inspection.grafts.some((graft) => graft.upstream.updateAvailable === true);
}

function assertAllowedChanges(inspection) {
  let extra;
  try {
    extra = JSON.parse(process.env.REGRAFT_ALLOWED_EXTRA_PATHS ?? "[]");
  } catch {
    throw new Error("REGRAFT_ALLOWED_EXTRA_PATHS must be a JSON array of repository-relative paths");
  }
  if (!Array.isArray(extra) || extra.some((path) => typeof path !== "string" || !path)) {
    throw new Error("REGRAFT_ALLOWED_EXTRA_PATHS must be a JSON array of non-empty repository-relative paths");
  }

  const allowed = [
    "regraft.json",
    "PATCH.md",
    ...inspection.grafts.map((graft) => graft.destination),
    ...extra,
  ];
  const disallowed = changedPaths().filter(
    (path) => !allowed.some((root) => path === root || path.startsWith(`${root}/`)),
  );
  if (disallowed.length > 0) {
    throw new Error(`Maintenance changed files outside the allowed Graft scope: ${disallowed.join(", ")}`);
  }
}

function runConfiguredCommand(command, label, extraEnvironment = {}) {
  if (!command) throw new Error(`${label} command is not configured`);
  const shell = process.env.SHELL || "/bin/sh";
  const result = run(shell, ["-lc", command], {
    stdio: "inherit",
    env: { ...process.env, ...extraEnvironment },
  });
  if (result.status !== 0) throw new Error(`${label} command exited ${result.status}`);
}

function invokeAgent(inspection) {
  const command = process.env.REGRAFT_AGENT_COMMAND;
  const pending = pendingEntries(inspection);
  const briefs = [...new Set(inspection.grafts.flatMap((graft) => graft.briefs))];
  const inspectionFile = resolve(temporaryDirectory, "inspect.json");
  writeFileSync(inspectionFile, `${JSON.stringify(inspection, null, 2)}\n`);

  if (!command) {
    throw new Error(
      `Update requires judgment for ${pending.map((entry) => entry.path).join(", ")}. ` +
        `Configure REGRAFT_AGENT_COMMAND or resolve the listed Briefs manually: ${briefs.join(", ") || "(none)"}`,
    );
  }

  runConfiguredCommand(command, "agent", {
    REGRAFT_INSPECT_FILE: inspectionFile,
    REGRAFT_BRIEF_FILES: JSON.stringify(briefs),
  });

  const after = inspect(true);
  assertAllowedChanges(after);
  const remaining = pendingEntries(after);
  const unrecorded = unrecordedEntries(after);
  if (remaining.length > 0 || unrecorded.length > 0 || after.exitCode !== 0) {
    throw new Error(
      `Agent left Regraft state requiring attention: ${[
        ...remaining.map((entry) => entry.path),
        ...unrecorded.map((entry) => entry.path),
      ].join(", ")}`,
    );
  }
}

function writeResult(result) {
  mkdirSync(dirname(resultFile), { recursive: true });
  writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function assertSafeStartingState() {
  runGit(["rev-parse", "--show-toplevel"]);
  const branch = runGit(["branch", "--show-current"]);
  if (!branch) throw new Error("Maintenance must run on a named Git branch");
  if (branchPrefix && !branch.startsWith(branchPrefix)) {
    throw new Error(`Maintenance must run on an isolated "${branchPrefix}*" branch; current branch is "${branch}"`);
  }

  const changes = runGit(["status", "--porcelain", "--untracked-files=normal"]);
  if (changes) throw new Error(`Maintenance branch must start clean:\n${changes}`);

  const local = inspect(true);
  const unrecorded = unrecordedEntries(local);
  if (unrecorded.length > 0) {
    throw new Error(`Record or discard local changes before maintenance: ${unrecorded.map((entry) => entry.path).join(", ")}`);
  }
}

function main() {
  if (!Number.isInteger(maximumRounds) || maximumRounds < 1 || maximumRounds > 10) {
    throw new Error("REGRAFT_MAX_ROUNDS must be an integer between 1 and 10");
  }

  assertSafeStartingState();
  let changed = false;
  let agentRuns = 0;
  const updates = [];

  for (let round = 1; round <= maximumRounds; round += 1) {
    let current = inspect(false);
    const pendingBeforePull = pendingEntries(current);
    if (pendingBeforePull.length > 0) {
      changed = true;
      invokeAgent(current);
      agentRuns += 1;
      current = inspect(false);
    }

    if (!updateAvailable(current)) break;

    const pull = runRegraft(["pull"]);
    for (const source of pull.sources) {
      if (source.oldSha !== source.newSha) {
        changed = true;
        updates.push({
          graft: source.name,
          fromRevision: source.oldSha,
          toRevision: source.newSha,
          added: source.added,
          fastForwarded: source.fastForwarded,
          merged: source.merged,
          deleted: source.deleted,
        });
      }
    }

    const afterPull = inspect(true);
    if (pendingEntries(afterPull).length > 0) {
      invokeAgent(afterPull);
      agentRuns += 1;
    } else if (afterPull.exitCode !== 0) {
      throw new Error("Regraft state requires attention after pull; inspect the offline JSON result");
    }
  }

  const finalOnline = inspect(false);
  if (pendingEntries(finalOnline).length > 0 || updateAvailable(finalOnline)) {
    throw new Error(`Maintenance did not converge within ${maximumRounds} rounds`);
  }
  const finalOffline = inspect(true);
  if (finalOffline.exitCode !== 0 || pendingEntries(finalOffline).length > 0 || unrecordedEntries(finalOffline).length > 0) {
    throw new Error("Maintenance finished with pending or unrecorded Regraft state");
  }

  if (changed) {
    runConfiguredCommand(process.env.REGRAFT_TEST_COMMAND, "test");
    const afterTests = inspect(true);
    assertAllowedChanges(afterTests);
    if (afterTests.exitCode !== 0 || pendingEntries(afterTests).length > 0 || unrecordedEntries(afterTests).length > 0) {
      throw new Error("Consumer tests left pending or unrecorded Regraft state");
    }
  }

  writeResult({
    status: changed ? "updated" : "no-update",
    agentRuns,
    updates,
  });
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeResult({ status: "failed", error: message });
  process.stderr.write(`regraft maintenance failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
