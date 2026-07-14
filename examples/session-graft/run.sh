#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI=(node "$ROOT/dist/cli.js")

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

if [[ ! -f "$ROOT/dist/cli.js" ]]; then
  echo "Build Regraft first: pnpm build" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/regraft-session-demo.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
UPSTREAM="$WORK/upstream"
PROJECT="$WORK/product"
mkdir -p "$UPSTREAM/packages/auth/src/session" "$PROJECT"

git -C "$UPSTREAM" init -q -b main
git -C "$UPSTREAM" config user.email demo@regraft.local
git -C "$UPSTREAM" config user.name "Regraft demo"
git -C "$UPSTREAM" config core.autocrlf false

cat > "$UPSTREAM/regraft.yaml" <<'YAML'
version: 1
grafts:
  session:
    path: packages/auth/src/session
    description: Session storage and trusted-device policy
YAML

cat > "$UPSTREAM/packages/auth/src/session/store.ts" <<'TS'
export const sessionDriver = database;

export function readSession(id: string) {
  return sessionDriver.get(id);
}

export function deleteSession(id: string) {
  return sessionDriver.delete(id);
}
TS

cat > "$UPSTREAM/packages/auth/src/session/policy.ts" <<'TS'
export const trustedDeviceDays = 7;

export function isTrusted(ageInDays: number) {
  return ageInDays <= trustedDeviceDays;
}
TS

git -C "$UPSTREAM" add -A
git -C "$UPSTREAM" commit -q -m "publish session Graft"

cd "$PROJECT"
"${CLI[@]}" add "file://$UPSTREAM#graft=session" src/session --name session

cat > src/session/store.ts <<'TS'
export const sessionDriver = redis;

export function readSession(id: string) {
  return sessionDriver.get(id);
}

export function deleteSession(id: string) {
  return sessionDriver.delete(id);
}
TS

cat > src/session/policy.ts <<'TS'
export const trustedDeviceDays = 30;

export function isTrusted(ageInDays: number) {
  return ageInDays <= trustedDeviceDays;
}
TS

"${CLI[@]}" note "Use Redis so stateless application nodes share session state" --files src/session/store.ts
"${CLI[@]}" note "Trust registered devices for 30 days to match the product security policy" --files src/session/policy.ts

cat >> "$UPSTREAM/packages/auth/src/session/store.ts" <<'TS'

export function cleanupExpiredSessions() {
  return sessionDriver.deleteExpired();
}
TS

cat > "$UPSTREAM/packages/auth/src/session/policy.ts" <<'TS'
export const trustedDeviceDays = 1;

export function isTrusted(ageInDays: number) {
  return ageInDays <= trustedDeviceDays;
}
TS

git -C "$UPSTREAM" add -A
git -C "$UPSTREAM" commit -q -m "add session cleanup and tighten trust policy"

if "${CLI[@]}" pull session; then
  echo "Expected the policy Update to require judgment." >&2
  exit 1
fi

assert_contains src/session/store.ts "sessionDriver = redis"
assert_contains src/session/store.ts "cleanupExpiredSessions"
assert_contains src/session/policy.ts "<<<<<<< local"

BRIEF="$(
  node -e '
    const manifest = require(process.argv[1]);
    const pending = manifest.grafts[0].files["policy.ts"].pending;
    if (!pending || !pending.brief) process.exit(1);
    process.stdout.write(pending.brief);
  ' "$PROJECT/regraft.json"
)"
assert_contains "$PROJECT/$BRIEF" "Trust registered devices for 30 days"
assert_contains "$PROJECT/$BRIEF" "tighten trust policy"

cat > src/session/policy.ts <<'TS'
// Product policy intentionally remains longer than upstream's default.
export const trustedDeviceDays = 30;

export function isTrusted(ageInDays: number) {
  return ageInDays <= trustedDeviceDays;
}
TS

"${CLI[@]}" resolve --graft session --note "Retained the 30-day trusted-device policy on upstream's revised default"

cat >> "$UPSTREAM/packages/auth/src/session/store.ts" <<'TS'

export function touchSession(id: string) {
  return sessionDriver.touch(id);
}
TS

git -C "$UPSTREAM" add -A
git -C "$UPSTREAM" commit -q -m "refresh active session expiry"

"${CLI[@]}" pull session

assert_contains src/session/store.ts "sessionDriver = redis"
assert_contains src/session/store.ts "cleanupExpiredSessions"
assert_contains src/session/store.ts "touchSession"
assert_contains src/session/policy.ts "trustedDeviceDays = 30"

"${CLI[@]}" inspect session --offline --json
echo
echo "Session Graft demo passed: deterministic Updates landed and local Intent survived."
