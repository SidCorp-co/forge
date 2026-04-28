#!/bin/bash
# Build, sign, and upload Forge Dev release to Strapi
#
# Usage:
#   ./build-release.sh linux           # Build Linux only
#   ./build-release.sh windows         # Build Windows only (from WSL)
#   ./build-release.sh both            # Build both platforms
#
# Environment:
#   FORGE_URL        — Strapi base URL (default: http://localhost:1337)
#   FORGE_TOKEN      — Strapi API token (preferred). If unset, the script will
#                      attempt a login using FORGE_USER / FORGE_PASSWORD.
#   FORGE_USER       — Strapi admin identifier (only used when FORGE_TOKEN unset)
#   FORGE_PASSWORD   — Strapi admin password   (only used when FORGE_TOKEN unset)
#   SKIP_BUMP=1      — Skip version bump (rebuild same version)
#   TAURI_SIGNING_PRIVATE_KEY_PATH — Path to signing key (default: ~/.tauri/forge-dev.key)
#
# The script:
#   1. Auto-bumps the patch version (set SKIP_BUMP=1 to skip)
#   2. Builds the Tauri app for the target platform(s)
#   3. Tauri auto-signs the update bundle when TAURI_SIGNING_PRIVATE_KEY_PATH is set
#   4. Uploads the signed bundle to Strapi as an app-release

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FORGE_URL="${FORGE_URL:-http://localhost:1337}"

# Login to get JWT if FORGE_TOKEN not already set
if [ -z "${FORGE_TOKEN:-}" ]; then
  if [ -z "${FORGE_USER:-}" ] || [ -z "${FORGE_PASSWORD:-}" ]; then
    echo "Error: set FORGE_TOKEN, or FORGE_USER and FORGE_PASSWORD for login." >&2
    exit 1
  fi
  echo "==> Logging in to ${FORGE_URL} as ${FORGE_USER}..."
  LOGIN_RESPONSE=$(curl -s -X POST "${FORGE_URL}/api/auth/local" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg u "$FORGE_USER" --arg p "$FORGE_PASSWORD" '{identifier:$u,password:$p}')")

  FORGE_TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"jwt":"[^"]*"' | cut -d'"' -f4)

  if [ -z "$FORGE_TOKEN" ]; then
    echo "ERROR: Login failed. Response: $LOGIN_RESPONSE"
    exit 1
  fi
  echo "  Login successful."
fi

export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-forgedev}"
TAURI_KEY_FILE="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/forge-dev.key}"
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ -f "$TAURI_KEY_FILE" ]; then
  export TAURI_SIGNING_PRIVATE_KEY
  TAURI_SIGNING_PRIVATE_KEY=$(cat "$TAURI_KEY_FILE")
fi

# --- Auto-bump patch version across all config files ---
bump_version() {
  local current="$1"
  local major minor patch
  IFS='.' read -r major minor patch <<< "$current"
  patch=$((patch + 1))
  echo "${major}.${minor}.${patch}"
}

# Compare two semver strings: returns 0 if a >= b, 1 if a < b
version_gte() {
  local a_major a_minor a_patch b_major b_minor b_patch
  IFS='.' read -r a_major a_minor a_patch <<< "$1"
  IFS='.' read -r b_major b_minor b_patch <<< "$2"
  [ "$a_major" -gt "$b_major" ] && return 0
  [ "$a_major" -lt "$b_major" ] && return 1
  [ "$a_minor" -gt "$b_minor" ] && return 0
  [ "$a_minor" -lt "$b_minor" ] && return 1
  [ "$a_patch" -ge "$b_patch" ] && return 0
  return 1
}

LOCAL_VERSION=$(grep -o '"version": "[^"]*"' "$SCRIPT_DIR/src-tauri/tauri.conf.json" | head -1 | cut -d'"' -f4)

# Fetch latest released version from Strapi to avoid version conflicts
STRAPI_VERSION=$(curl -s -g "${FORGE_URL}/api/app-releases?sort=id:desc&pagination[pageSize]=1" \
  -H "Authorization: Bearer ${FORGE_TOKEN}" 2>/dev/null \
  | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$STRAPI_VERSION" ] && echo "==> Latest Strapi release: v${STRAPI_VERSION}"

# Use the higher of local vs Strapi as the base version
if [ -n "$STRAPI_VERSION" ] && ! version_gte "$LOCAL_VERSION" "$STRAPI_VERSION"; then
  CURRENT_VERSION="$STRAPI_VERSION"
  echo "==> Local v${LOCAL_VERSION} < Strapi v${STRAPI_VERSION}, using Strapi as base"
else
  CURRENT_VERSION="$LOCAL_VERSION"
fi

if [ "${SKIP_BUMP:-}" = "1" ]; then
  VERSION="$CURRENT_VERSION"
  echo "==> Skipping version bump (SKIP_BUMP=1), using v${VERSION}"
else
  VERSION=$(bump_version "$CURRENT_VERSION")
  echo "==> Bumping version: v${CURRENT_VERSION} → v${VERSION}"

  # Update tauri.conf.json
  sed -i "s/\"version\": \"${LOCAL_VERSION}\"/\"version\": \"${VERSION}\"/" "$SCRIPT_DIR/src-tauri/tauri.conf.json"
  # Update Cargo.toml
  sed -i "s/^version = \"${LOCAL_VERSION}\"/version = \"${VERSION}\"/" "$SCRIPT_DIR/src-tauri/Cargo.toml"
  # Update package.json
  sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$SCRIPT_DIR/package.json"

  echo "  Updated: tauri.conf.json, Cargo.toml, package.json"
fi

echo "==> Building Forge Dev v${VERSION}"

# --- Helper: upload release to Strapi ---
upload_to_strapi() {
  local platform="$1"
  local bundle_path="$2"
  local sig_path="$3"

  if [ ! -f "$bundle_path" ]; then
    echo "ERROR: Bundle not found at $bundle_path"
    return 1
  fi
  if [ ! -f "$sig_path" ]; then
    echo "ERROR: Signature not found at $sig_path"
    return 1
  fi

  local signature
  signature=$(cat "$sig_path")
  local filename
  filename=$(basename "$bundle_path")

  echo "  Uploading $filename ($platform) to Strapi..."

  # 1. Upload the binary file via Strapi upload API
  local upload_response
  upload_response=$(curl -s -X POST "${FORGE_URL}/api/upload" \
    -H "Authorization: Bearer ${FORGE_TOKEN}" \
    -F "files=@${bundle_path}" \
    -F "fileInfo=$(printf '[{"name":"%s"}]' "$filename")")

  local file_id
  file_id=$(echo "$upload_response" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

  if [ -z "$file_id" ]; then
    echo "ERROR: Upload failed. Response: $upload_response"
    return 1
  fi

  echo "  Uploaded file (id: $file_id)"

  # 2. Unmark any existing isCurrent release for this platform
  local existing
  existing=$(curl -s -g "${FORGE_URL}/api/app-releases?filters[platform]=${platform}&filters[isCurrent]=true" \
    -H "Authorization: Bearer ${FORGE_TOKEN}")

  local existing_ids
  existing_ids=$(echo "$existing" | grep -o '"documentId":"[^"]*"' | cut -d'"' -f4 || true)

  for doc_id in $existing_ids; do
    echo "  Unmarking previous current release: $doc_id"
    curl -s -X PUT "${FORGE_URL}/api/app-releases/${doc_id}" \
      -H "Authorization: Bearer ${FORGE_TOKEN}" \
      -H "Content-Type: application/json" \
      -d '{"data":{"isCurrent":false}}' > /dev/null
  done

  # 3. Create the app-release entry
  local payload
  payload=$(python3 -c "
import json, sys
print(json.dumps({'data': {
    'version': sys.argv[1],
    'platform': sys.argv[2],
    'signature': sys.argv[3],
    'binary': int(sys.argv[4]),
    'isCurrent': True,
    'notes': f'Forge Dev v{sys.argv[1]} for {sys.argv[2]}'
}}))" "$VERSION" "$platform" "$signature" "$file_id")

  local create_response
  create_response=$(curl -s -X POST "${FORGE_URL}/api/app-releases" \
    -H "Authorization: Bearer ${FORGE_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$payload")

  local created_id
  created_id=$(echo "$create_response" | grep -o '"documentId":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -z "$created_id" ]; then
    echo "ERROR: Failed to create release. Response: $create_response"
    return 1
  fi

  # 4. Publish the release
  curl -s -X POST "${FORGE_URL}/api/app-releases/${created_id}/actions/publish" \
    -H "Authorization: Bearer ${FORGE_TOKEN}" \
    -H "Content-Type: application/json" > /dev/null 2>&1 || true

  echo "  Release created: ${created_id} (v${VERSION} / ${platform})"
}

# --- Build Linux ---
build_linux() {
  echo ""
  echo "==> Building Linux..."
  cd "$SCRIPT_DIR"
  npm install --silent 2>/dev/null
  npx tauri build --bundles appimage 2>&1

  # Find the AppImage bundle and its signature
  local bundle_dir="$SCRIPT_DIR/src-tauri/target/release/bundle"
  local appimage
  appimage=$(find "$bundle_dir/appimage" -name "*.AppImage" ! -name "*.sig" 2>/dev/null | head -1)
  local sig_file="${appimage}.sig"

  echo ""
  echo "==> Linux build artifacts:"
  [ -n "$appimage" ] && echo "  AppImage: $appimage ($(du -h "$appimage" | cut -f1))"
  [ -f "$sig_file" ] && echo "  Signature: $sig_file"

  if [ -n "$appimage" ] && [ -f "$sig_file" ]; then
    upload_to_strapi "linux-x86_64" "$appimage" "$sig_file"

    # Clean up Linux build artifacts to save storage
    echo "  Cleaning up Linux build artifacts..."
    rm -rf "$SCRIPT_DIR/src-tauri/target/release/bundle" 2>/dev/null || true
    rm -f "$SCRIPT_DIR/src-tauri/target/release/forge-dev" 2>/dev/null || true
  else
    echo "WARN: Skipping upload — missing AppImage or signature"
  fi
}

# --- Build Windows (from WSL) ---
build_windows() {
  echo ""
  echo "==> Building Windows (from WSL)..."

  # Use a timestamped build folder to avoid file-lock issues with running app
  local BUILD_TS
  BUILD_TS=$(date +%Y%m%d%H%M%S)
  local WIN_SRC="C:\\Users\\Admin\\forge-dev-build-${BUILD_TS}"
  local WIN_SRC_UNC="\\\\wsl.localhost\\Ubuntu-24.04${SCRIPT_DIR}"
  local WIN_SRC_UNIX="/mnt/c/Users/Admin/forge-dev-build-${BUILD_TS}"

  # Copy source to fresh Windows folder
  echo "  Syncing source to ${WIN_SRC}..."
  cd /mnt/c/Windows
  /mnt/c/Windows/System32/cmd.exe /c \
    "robocopy ${WIN_SRC_UNC} ${WIN_SRC} /E /XD node_modules target .git /NFL /NDL" \
    || true

  # Copy Cargo deps cache from latest previous build (speeds up compilation)
  local PREV_UNIX
  PREV_UNIX=$(ls -1d /mnt/c/Users/Admin/forge-dev-build-*/src-tauri/target 2>/dev/null | grep -v "$BUILD_TS" | tail -1 || true)
  if [ -n "$PREV_UNIX" ] && [ -d "$PREV_UNIX/release/deps" ]; then
    local PREV_WIN
    PREV_WIN=$(echo "$PREV_UNIX" | sed 's|/mnt/c/|C:\\|;s|/|\\|g')
    echo "  Copying Cargo deps cache from previous build..."
    /mnt/c/Windows/System32/cmd.exe /c \
      "robocopy ${PREV_WIN}\\release\\deps ${WIN_SRC}\\src-tauri\\target\\release\\deps /E /NFL /NDL 2>nul" \
      || true
  fi

  # Clean up ALL old build folders now that cache is copied
  echo "  Cleaning up old build folders..."
  for old in /mnt/c/Users/Admin/forge-dev-build-*/; do
    [ -d "$old" ] || continue
    echo "$old" | grep -q "$BUILD_TS" && continue
    local OLD_WIN
    OLD_WIN=$(echo "${old%/}" | sed 's|/mnt/c/|C:\\|;s|/|\\|g')
    /mnt/c/Windows/System32/cmd.exe /c "rd /s /q ${OLD_WIN}" 2>/dev/null || true
  done

  # Signing key
  mkdir -p /mnt/c/Users/Admin/.tauri 2>/dev/null || true
  cp "$TAURI_KEY_FILE" "/mnt/c/Users/Admin/.tauri/forge-dev.key"
  local win_key_content
  win_key_content=$(cat "$TAURI_KEY_FILE")

  # Install deps
  echo "  Installing npm dependencies..."
  /mnt/c/Windows/System32/cmd.exe /c \
    "cd /d ${WIN_SRC} && npm install" 2>&1

  # Build with signing key (run in background + poll for completion)
  echo "  Building Tauri Windows exe (with signing)..."

  /mnt/c/Windows/System32/cmd.exe /c \
    "set TAURI_SIGNING_PRIVATE_KEY=${win_key_content}&& set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=forgedev&& set LIB=C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\VC\\Tools\\MSVC\\14.29.30037\\lib\\x64;%LIB% && cd /d ${WIN_SRC} && npx tauri build --bundles nsis" 2>&1 &
  local BUILD_PID=$!

  # Poll: wait for NSIS installer + .sig to appear, then kill the hung cmd.exe
  local MAX_WAIT=1200  # 20 min max
  local WAITED=0
  while [ $WAITED -lt $MAX_WAIT ]; do
    # Check if the .sig file exists (written last by Tauri)
    local SIG_CHECK
    SIG_CHECK=$(find "$WIN_SRC_UNIX/src-tauri/target/release/bundle/nsis" -name "*_${VERSION}_x64-setup.exe.sig" 2>/dev/null | head -1)
    if [ -n "$SIG_CHECK" ]; then
      echo "  Build complete — NSIS installer + signature found."
      sleep 2  # let any final writes flush
      kill $BUILD_PID 2>/dev/null || true
      wait $BUILD_PID 2>/dev/null || true
      break
    fi
    # Check if build process died on its own (error)
    if ! kill -0 $BUILD_PID 2>/dev/null; then
      echo "  Build process exited."
      wait $BUILD_PID 2>/dev/null || true
      break
    fi
    sleep 5
    WAITED=$((WAITED + 5))
  done

  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "ERROR: Build timed out after ${MAX_WAIT}s"
    kill $BUILD_PID 2>/dev/null || true
    return 1
  fi

  # Find Windows artifacts
  local win_bundle_dir="$WIN_SRC_UNIX/src-tauri/target/release/bundle"

  echo ""
  echo "==> Windows build artifacts:"
  local exe="$WIN_SRC_UNIX/src-tauri/target/release/forge-dev.exe"
  [ -f "$exe" ] && echo "  Executable: $exe ($(du -h "$exe" | cut -f1))"

  local nsis_installer
  nsis_installer=$(find "$win_bundle_dir/nsis" -name "*.exe" ! -name "*.sig" 2>/dev/null | head -1)
  local nsis_zip
  nsis_zip=$(find "$win_bundle_dir/nsis" -name "*.nsis.zip" ! -name "*.sig" 2>/dev/null | head -1)

  local upload_file="${nsis_zip:-$nsis_installer}"
  local sig_file="${upload_file}.sig"

  [ -n "$nsis_installer" ] && echo "  NSIS installer: $nsis_installer ($(du -h "$nsis_installer" | cut -f1))"
  [ -n "$nsis_zip" ] && echo "  NSIS zip: $nsis_zip"
  [ -f "$sig_file" ] && echo "  Signature: $sig_file"

  if [ -n "$upload_file" ] && [ -f "$sig_file" ]; then
    upload_to_strapi "windows-x86_64" "$upload_file" "$sig_file"
  else
    echo "WARN: Skipping upload — missing NSIS bundle or signature"
  fi

}

# --- Main ---
PLATFORM="${1:-both}"

case "$PLATFORM" in
  linux)
    build_linux
    ;;
  windows)
    build_windows
    ;;
  both)
    build_windows
    build_linux
    ;;
  *)
    echo "Usage: $0 [linux|windows|both]"
    exit 1
    ;;
esac

echo ""
echo "==> All done! Releases uploaded to ${FORGE_URL}"
