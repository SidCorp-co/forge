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
# Refuse by name unless the download matches the sha256 core publishes for this target.
want=$(curl -fsSL "$BASE/api/install/latest.json" | tr -d ' \n' | sed -n 's/.*"'"$target"'":{[^}]*"sha256":"\([0-9a-f]*\)".*/\1/p')
[ -n "$want" ] || { rm -f "$dest/forge-runner.new"; echo "INSTALL_SHA256_UNPUBLISHED: core publishes no sha256 for $target, so the download cannot be verified; nothing was installed." >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$dest/forge-runner.new" | cut -d' ' -f1); else got=$(shasum -a 256 "$dest/forge-runner.new" | cut -d' ' -f1); fi
[ "$got" = "$want" ] || { rm -f "$dest/forge-runner.new"; echo "INSTALL_SHA256_MISMATCH: forge-runner for $target hashed $got, core publishes $want; nothing was installed." >&2; exit 1; }
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
echo "Next:  forge-runner login --core-url $BASE"
