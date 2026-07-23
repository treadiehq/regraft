#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLI="$ROOT/dist/cli.js"
MAINTAIN="$ROOT/examples/session-graft/automation/maintain.mjs"

if [[ ! -f "$CLI" ]]; then
  echo "Build Regraft first: pnpm build" >&2
  exit 1
fi

assert_contains() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs");
const [file, needle] = process.argv.slice(2);
if (!fs.readFileSync(file, "utf8").includes(needle)) {
  console.error(`Expected ${file} to contain: ${needle}`);
  process.exit(1);
}
NODE
}

assert_result() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs");
const [file, expected] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(file, "utf8"));
if (result.status !== expected) {
  console.error(`Expected ${file} status ${expected}, received ${JSON.stringify(result)}`);
  process.exit(1);
}
NODE
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/regraft-automation.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
PROVIDER="$WORK/provider"
CONSUMER="$WORK/consumer"
RESULT="$WORK/result.json"
mkdir -p "$PROVIDER/packages/auth/src/session" "$CONSUMER"

git -C "$PROVIDER" init -q -b main
git -C "$PROVIDER" config user.email provider@regraft.local
git -C "$PROVIDER" config user.name "Example API provider"
git -C "$PROVIDER" config core.autocrlf false

cat > "$PROVIDER/regraft.yaml" <<'YAML'
version: 1
grafts:
  session:
    path: packages/auth/src/session
    description: Session storage and trusted-device policy
YAML

cat > "$PROVIDER/packages/auth/src/session/store.ts" <<'TS'
export const sessionDriver = database;

export function readSession(id: string) {
  return sessionDriver.get(id);
}
TS

cat > "$PROVIDER/packages/auth/src/session/policy.ts" <<'TS'
export const trustedDeviceDays = 7;

export function isTrusted(ageInDays: number) {
  return ageInDays <= trustedDeviceDays;
}
TS

git -C "$PROVIDER" add -A
git -C "$PROVIDER" commit -q -m "publish session integration"

git -C "$CONSUMER" init -q -b main
git -C "$CONSUMER" config user.email consumer@regraft.local
git -C "$CONSUMER" config user.name "Example API consumer"
git -C "$CONSUMER" config core.autocrlf false

cd "$CONSUMER"
node "$CLI" add "file://$PROVIDER#graft=session" src/session --name session

cat > src/session/store.ts <<'TS'
export const sessionDriver = redis;

export function readSession(id: string) {
  return sessionDriver.get(id);
}
TS

cat > src/session/policy.ts <<'TS'
export const trustedDeviceDays = 30;

export function isTrusted(ageInDays: number) {
  return ageInDays <= trustedDeviceDays;
}
TS

node "$CLI" note "Use Redis so stateless application nodes share session state" --files src/session/store.ts
node "$CLI" note "Trust registered devices for 30 days to match product policy" --files src/session/policy.ts

cat > test-session.mjs <<'JS'
import { readFileSync } from "node:fs";

const store = readFileSync("src/session/store.ts", "utf8");
const policy = readFileSync("src/session/policy.ts", "utf8");

if (!store.includes("sessionDriver = redis")) throw new Error("Redis adaptation was lost");
if (!policy.includes("trustedDeviceDays = 30")) throw new Error("Trusted-device policy was lost");
if (store.includes("BROKEN_SESSION_UPDATE")) throw new Error("Provider regression reached the PR");
JS

git add -A
git commit -q -m "adopt customized session integration"
git switch -q -c regraft/maintenance

REGRAFT_BIN="$CLI" \
REGRAFT_RESULT_FILE="$RESULT" \
REGRAFT_TEST_COMMAND="node test-session.mjs" \
node "$MAINTAIN"
assert_result "$RESULT" "no-update"
[[ -z "$(git status --porcelain)" ]]

cat >> "$PROVIDER/packages/auth/src/session/store.ts" <<'TS'

export function cleanupExpiredSessions() {
  return sessionDriver.deleteExpired();
}
TS
git -C "$PROVIDER" add -A
git -C "$PROVIDER" commit -q -m "add expired-session cleanup"

REGRAFT_BIN="$CLI" \
REGRAFT_RESULT_FILE="$RESULT" \
REGRAFT_TEST_COMMAND="node test-session.mjs" \
node "$MAINTAIN"
assert_result "$RESULT" "updated"
assert_contains src/session/store.ts "sessionDriver = redis"
assert_contains src/session/store.ts "cleanupExpiredSessions"

git add -A
git commit -q -m "chore: apply clean Regraft update"
git show main:src/session/store.ts > "$WORK/main-store.ts"
if node - "$WORK/main-store.ts" <<'NODE'
const fs = require("node:fs");
process.exit(fs.readFileSync(process.argv[2], "utf8").includes("cleanupExpiredSessions") ? 0 : 1);
NODE
then
  echo "Maintenance update escaped the isolated branch." >&2
  exit 1
fi

REGRAFT_BIN="$CLI" \
REGRAFT_RESULT_FILE="$RESULT" \
REGRAFT_TEST_COMMAND="node test-session.mjs" \
node "$MAINTAIN"
assert_result "$RESULT" "no-update"
[[ -z "$(git status --porcelain)" ]]

cat > "$PROVIDER/packages/auth/src/session/policy.ts" <<'TS'
export const trustedDeviceDays = 1;

export function isTrusted(ageInDays: number) {
  return ageInDays <= trustedDeviceDays;
}
TS
git -C "$PROVIDER" add -A
git -C "$PROVIDER" commit -q -m "tighten provider trusted-device default"

AGENT="$WORK/fixture-agent.mjs"
cat > "$AGENT" <<'JS'
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

writeFileSync(
  "src/session/policy.ts",
  `// Consumer policy intentionally remains longer than the provider default.
export const trustedDeviceDays = 30;

export function isTrusted(ageInDays: number) {
  return ageInDays <= trustedDeviceDays;
}
`,
);

const result = spawnSync(
  process.execPath,
  [
    process.env.REGRAFT_BIN,
    "resolve",
    "--graft",
    "session",
    "--note",
    "Retained the consumer's 30-day trusted-device policy on the provider's new default",
    "--json",
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
JS

REGRAFT_BIN="$CLI" \
REGRAFT_RESULT_FILE="$RESULT" \
REGRAFT_TEST_COMMAND="node test-session.mjs" \
REGRAFT_AGENT_COMMAND="node '$AGENT'" \
node "$MAINTAIN"
assert_result "$RESULT" "updated"
assert_contains src/session/policy.ts "trustedDeviceDays = 30"
if node - src/session/policy.ts <<'NODE'
const fs = require("node:fs");
process.exit(fs.readFileSync(process.argv[2], "utf8").includes("<<<<<<<") ? 0 : 1);
NODE
then
  echo "Fixture agent left conflict markers." >&2
  exit 1
fi

git add -A
git commit -q -m "chore: apply agent-resolved Regraft update"

cat >> "$PROVIDER/packages/auth/src/session/store.ts" <<'TS'

export const BROKEN_SESSION_UPDATE = true;
TS
git -C "$PROVIDER" add -A
git -C "$PROVIDER" commit -q -m "introduce provider regression"

BEFORE_FAILURE="$(git rev-parse HEAD)"
if REGRAFT_BIN="$CLI" \
  REGRAFT_RESULT_FILE="$RESULT" \
  REGRAFT_TEST_COMMAND="node test-session.mjs" \
  node "$MAINTAIN"; then
  echo "Expected the consumer test command to reject the provider regression." >&2
  exit 1
fi
assert_result "$RESULT" "failed"
[[ "$(git rev-parse HEAD)" == "$BEFORE_FAILURE" ]]
[[ -n "$(git status --porcelain)" ]]

echo "Automation pilot passed: no-op, clean Update, isolated PR branch, agent judgment, repeated run, and test failure."
