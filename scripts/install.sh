#!/usr/bin/env bash
#
# regraft installer — download a prebuilt binary and put it on your PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/treadiehq/regraft/main/scripts/install.sh | bash
#
# Environment overrides:
#   REGRAFT_VERSION   release tag to install, e.g. v0.1.0 (default: latest)
#   REGRAFT_BIN_DIR   where to install the `regraft` binary
#                     (default: /usr/local/bin if writable, else ~/.local/bin)
#   REGRAFT_REPO      owner/repo to download releases from (default: treadiehq/regraft)
#
set -euo pipefail

REPO="${REGRAFT_REPO:-treadiehq/regraft}"
VERSION="${REGRAFT_VERSION:-latest}"
BIN_NAME="regraft"

if [ -t 1 ]; then
  bold=$(printf '\033[1m'); dim=$(printf '\033[2m'); green=$(printf '\033[32m')
  red=$(printf '\033[31m'); reset=$(printf '\033[0m')
else
  bold=""; dim=""; green=""; red=""; reset=""
fi
say()  { printf '%s\n' "${dim}→${reset} $*"; }
ok()   { printf '%s\n' "${green}✓${reset} $*"; }
die()  { printf '%s\n' "${red}✗${reset} $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

need curl

# --- detect platform ---------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Linux)  OS="linux" ;;
  Darwin) OS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    die "this is the Unix installer. On Windows, install with PowerShell:
  irm https://raw.githubusercontent.com/${REPO}/main/scripts/install.ps1 | iex" ;;
  *) die "unsupported OS: $OS (regraft supports Linux, macOS, and Windows)" ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) die "unsupported architecture: $ARCH (regraft supports x64 and arm64)" ;;
esac

ASSET="${BIN_NAME}-${OS}-${ARCH}"
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
fi

# --- pick an install dir (no sudo) -------------------------------------------
if [ -n "${REGRAFT_BIN_DIR:-}" ]; then
  BIN_DIR="$REGRAFT_BIN_DIR"
elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="$HOME/.local/bin"
fi
mkdir -p "$BIN_DIR"

# --- download + install ------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "downloading ${bold}${ASSET}${reset} (${VERSION}) for ${OS}-${ARCH}"
if ! curl -fSL --progress-bar "$URL" -o "$TMP/$BIN_NAME"; then
  die "download failed: $URL
  - no release asset for your platform yet, or
  - the version tag does not exist (check: https://github.com/${REPO}/releases)"
fi

chmod +x "$TMP/$BIN_NAME"
mv -f "$TMP/$BIN_NAME" "$BIN_DIR/$BIN_NAME"

if ! "$BIN_DIR/$BIN_NAME" --version >/dev/null 2>&1; then
  die "the installed binary failed to run ($BIN_DIR/$BIN_NAME)"
fi
ok "installed ${bold}regraft $("$BIN_DIR/$BIN_NAME" --version)${reset} → $BIN_DIR/$BIN_NAME"

# --- PATH hint ---------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf '\n'
    say "add ${bold}$BIN_DIR${reset} to your PATH, e.g.:"
    printf '    echo '\''export PATH="%s:$PATH"'\'' >> ~/.zshrc && source ~/.zshrc\n' "$BIN_DIR"
    ;;
esac

printf '\n'
ok "regraft installed. Get started with:"
printf '    %sregraft add owner/repo/tree/main/src/components lib/components%s\n' "$bold" "$reset"
printf '\n'
printf '%sUpdate later with:%s  regraft update\n' "$dim" "$reset"
