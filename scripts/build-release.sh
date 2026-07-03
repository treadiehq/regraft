#!/usr/bin/env bash
#
# Build standalone `regraft` binaries for every supported platform.
#
# Output: dist/release/regraft-<os>-<arch>  (linux/darwin × x64/arm64, plus windows-x64.exe)
# Requires: Bun (https://bun.sh). macOS binaries are ad-hoc codesigned when this
# runs on macOS. Cross-compiled targets are emitted but only the host platform's
# binary can be smoke-tested locally — CI builds each on its native runner.
#
#   bash scripts/build-release.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY="$ROOT/src/cli.ts"
OUT="$ROOT/dist/release"

command -v bun >/dev/null 2>&1 || {
  echo "Bun is required to build binaries. Install it: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
}

VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo 0.0.0)"
echo "Building regraft v$VERSION binaries with bun $(bun --version)"

rm -rf "$OUT"
mkdir -p "$OUT"

# name : bun target
PLATFORMS=(
  "regraft-linux-x64:bun-linux-x64"
  "regraft-linux-arm64:bun-linux-arm64"
  "regraft-darwin-x64:bun-darwin-x64"
  "regraft-darwin-arm64:bun-darwin-arm64"
  "regraft-windows-x64.exe:bun-windows-x64"
)

for entry in "${PLATFORMS[@]}"; do
  NAME="${entry%%:*}"
  TARGET="${entry##*:}"
  OUTFILE="$OUT/$NAME"

  printf '  %-24s' "$NAME"

  unset BUN_NO_CODESIGN_MACHO_BINARY
  case "$NAME" in
    *darwin*) export BUN_NO_CODESIGN_MACHO_BINARY=1 ;;
  esac

  # The version is baked in via __REGRAFT_VERSION__ since there's no
  # package.json next to a compiled binary.
  bun build "$ENTRY" \
    --compile \
    --target="$TARGET" \
    --outfile="$OUTFILE" \
    --define __REGRAFT_VERSION__="\"$VERSION\"" >/dev/null

  case "$NAME" in
    *darwin*)
      if [ "$(uname -s)" = "Darwin" ]; then
        bash "$SCRIPT_DIR/adhoc-codesign-macos.sh" "$OUTFILE"
      fi
      ;;
  esac

  echo "ok ($(du -h "$OUTFILE" | cut -f1))"
done

echo
echo "Binaries written to $OUT:"
ls -lh "$OUT"
