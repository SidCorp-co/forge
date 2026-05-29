#!/bin/sh
# forge-runner installer.
#
# Preferred usage (core serves a host-aware copy of this script):
#   curl -fsSL https://<core>/install.sh | sh
#
# Direct usage of this repo copy: set the core base URL first:
#   FORGE_CORE_URL=https://<core> sh install.sh
set -e

BASE="${FORGE_CORE_URL:-}"
[ -n "$BASE" ] || { echo "set FORGE_CORE_URL (or use: curl <core>/install.sh | sh)" >&2; exit 1; }

os=$(uname -s); arch=$(uname -m)
case "$os" in
  Linux) plat="unknown-linux-gnu";;
  Darwin) plat="apple-darwin";;
  *) echo "unsupported OS: $os" >&2; exit 1;;
esac
case "$arch" in
  x86_64|amd64) cpu="x86_64";;
  aarch64|arm64) cpu="aarch64";;
  *) echo "unsupported arch: $arch" >&2; exit 1;;
esac
target="$cpu-$plat"

dest="$HOME/.local/bin"
mkdir -p "$dest"
echo "Downloading forge-runner ($target)..."
curl -fsSL "$BASE/install/bin/$target" -o "$dest/forge-runner.new"
chmod +x "$dest/forge-runner.new"
mv "$dest/forge-runner.new" "$dest/forge-runner"
echo "Installed to $dest/forge-runner"

case ":$PATH:" in
  *":$dest:"*) ;;
  *) echo "Add to PATH:  export PATH=\"$dest:\$PATH\"";;
esac
echo "Next:  forge-runner login --core-url $BASE --code <CODE>"
