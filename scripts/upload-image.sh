#!/usr/bin/env bash
#
# upload-image.sh — upload screenshots / images to a Forge issue or comment
# via REST API. Designed for the MCP runner / CI scripts that have a PAT or
# device token but NO user JWT.
#
# Usage:
#   upload-image.sh --issue   <issueId>   <file> [<file>...]
#   upload-image.sh --comment <commentId> <file> [<file>...]
#
# Env (required):
#   FORGE_API_URL    e.g. https://forge.example.com   (no trailing slash)
#   FORGE_API_TOKEN  PAT (forge_pat_*) or device token — sent as Bearer
#
# Output (stdout):
#   JSON array, one object per uploaded file:
#     [{ "id": "...", "name": "...", "mime": "...", "size": N,
#        "url": "/api/attachments/<id>/download" }, ...]
#
# Exit codes:
#   0  all files uploaded
#   1  upload failed (HTTP 4xx/5xx, file not found, env missing)
#   2  bad arguments
#
# Notes:
#   - The combined-auth middleware (`requireAnyAuth`) accepts user JWT, PAT,
#     or device token. For the runner, FORGE_API_TOKEN is the PAT or device
#     token issued at pairing time.
#   - `--issue` posts to `/api/issues/<id>/attachments`.
#   - `--comment` posts to `/api/comments/<id>/attachments`.
#   - Max size per file + total: capped server-side by `UPLOADS_MAX_BYTES`
#     (HTTP 400 FILE_TOO_LARGE if exceeded).
#
set -euo pipefail

usage() {
  sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-2}"
}

: "${FORGE_API_URL:?FORGE_API_URL env var required}"
: "${FORGE_API_TOKEN:?FORGE_API_TOKEN env var required}"

MODE=""
PARENT_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue)
      [[ $# -ge 2 ]] || usage 2
      MODE="issue"; PARENT_ID="$2"; shift 2 ;;
    --comment)
      [[ $# -ge 2 ]] || usage 2
      MODE="comment"; PARENT_ID="$2"; shift 2 ;;
    -h|--help)
      usage 0 ;;
    -*)
      echo "Unknown flag: $1" >&2; usage 2 ;;
    *)
      break ;;
  esac
done

[[ -n "$MODE" ]]      || { echo "Specify --issue or --comment" >&2; usage 2; }
[[ -n "$PARENT_ID" ]] || { echo "Missing parent ID" >&2; usage 2; }
[[ $# -gt 0 ]]        || { echo "No files to upload" >&2; usage 2; }

# UUID-ish sanity check on the parent ID — fail fast before hitting the API
if ! [[ "$PARENT_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "Invalid UUID: $PARENT_ID" >&2
  exit 2
fi

if [[ "$MODE" == "issue" ]]; then
  URL_BASE="${FORGE_API_URL%/}/api/issues/$PARENT_ID/attachments"
else
  URL_BASE="${FORGE_API_URL%/}/api/comments/$PARENT_ID/attachments"
fi

results=()
for file in "$@"; do
  if [[ ! -f "$file" ]]; then
    echo "File not found: $file" >&2
    exit 1
  fi
  if [[ ! -r "$file" ]]; then
    echo "File not readable: $file" >&2
    exit 1
  fi

  # Status code goes to stderr-suppressed temp; body to stdout
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT

  http_code=$(
    curl -sS \
      -o "$tmp" \
      -w '%{http_code}' \
      -H "Authorization: Bearer $FORGE_API_TOKEN" \
      -F "file=@$file" \
      "$URL_BASE"
  )

  if [[ "$http_code" != "201" && "$http_code" != "200" ]]; then
    echo "Upload failed for $file: HTTP $http_code" >&2
    cat "$tmp" >&2
    echo >&2
    rm -f "$tmp"
    exit 1
  fi

  results+=("$(cat "$tmp")")
  rm -f "$tmp"
  trap - EXIT
done

# Emit JSON array. If exactly one result, still wrap in [].
printf '['
for i in "${!results[@]}"; do
  [[ $i -gt 0 ]] && printf ','
  printf '%s' "${results[$i]}"
done
printf ']\n'
