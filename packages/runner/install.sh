#!/bin/sh
# forge-runner installer.
#
# Preferred usage (core serves a host-aware copy of this script):
#   curl -fsSL https://<core>/api/install.sh | sh
#
# Direct usage of this repo copy: set the core base URL first:
#   FORGE_CORE_URL=https://<core> sh install.sh
#
# Auto-update defaults ON (ISS-392). Opt a device out with --no-auto-update:
#   curl -fsSL https://<core>/api/install.sh | sh -s -- --no-auto-update
set -e

BASE="${FORGE_CORE_URL:-}"
[ -n "$BASE" ] || { echo "set FORGE_CORE_URL (or use: curl <core>/api/install.sh | sh)" >&2; exit 1; }

AUTO_UPDATE=1
for arg in "$@"; do
  case "$arg" in
    --no-auto-update) AUTO_UPDATE=0;;
  esac
done

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
# Install routes are served under /api so the download rides the same proxied
# channel the runner uses for everything else (ISS-392); core also serves them
# at the root for directly-exposed self-hosts.
curl -fsSL "$BASE/api/install/bin/$target" -o "$dest/forge-runner.new"
chmod +x "$dest/forge-runner.new"
mv "$dest/forge-runner.new" "$dest/forge-runner"
echo "Installed to $dest/forge-runner"

if [ "$AUTO_UPDATE" = "0" ]; then
  "$dest/forge-runner" config set update.auto false || true
  echo "Auto-update disabled for this device."
else
  echo "Auto-update is ON (disable later with: forge-runner config set update.auto false)"
fi

case ":$PATH:" in
  *":$dest:"*) ;;
  *) echo "Add to PATH:  export PATH=\"$dest:\$PATH\"";;
esac
echo "Next:  forge-runner login --core-url $BASE --code <CODE>"
