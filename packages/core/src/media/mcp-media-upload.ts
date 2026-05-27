import { Hono } from 'hono';

/**
 * The `mcp-media-upload.sh` helper, served verbatim at GET /mcp-media-upload.sh.
 *
 * It exists so MCP agents (and humans) can attach images/files to an issue or
 * comment WITHOUT base64-inlining the bytes through the model context — the
 * file is streamed straight to the existing multipart endpoints
 * (`POST /api/{issues,comments}/:id/attachments`) and only the short attachment
 * JSON ({id, url, ...}) comes back.
 *
 * Kept inline (not a `.sh` asset on disk) so it ships with the `tsc` build
 * without a copy step. `\${` escapes are required so the bash `${...}`
 * expansions survive the surrounding TS template literal.
 */
export const MCP_MEDIA_UPLOAD_SH = `#!/usr/bin/env bash
# mcp-media-upload.sh - upload local files to a Forge issue or comment as
# attachments (multipart), so MCP agents never base64-inline file bytes.
#
# usage:
#   FORGE_URL=https://api.example.com FORGE_TOKEN=<bearer> mcp-media-upload.sh --issue <issueId> a.png [b.pdf ...]
#   FORGE_URL=... FORGE_TOKEN=... mcp-media-upload.sh --comment <commentId> shot.png
#
# pipe straight from the API (FORGE_URL = the origin you fetched the script from):
#   curl -fsSL "$FORGE_URL/mcp-media-upload.sh" | FORGE_URL="$FORGE_URL" FORGE_TOKEN="$FORGE_TOKEN" bash -s -- --issue <issueId> ./file.png
#
# prints the server attachment JSON ({id,name,mime,size,url,...}) per file to
# stdout; reference the returned url in the issue/comment body. nonzero exit on failure.
set -euo pipefail

die() { echo "mcp-media-upload: $*" >&2; exit 1; }

guess_mime() {
  local p="$1" m=""
  command -v file >/dev/null 2>&1 && m="$(file --mime-type -b "$p" 2>/dev/null || true)"
  if [ -z "$m" ] || [ "$m" = "application/octet-stream" ]; then
    case "\${p##*.}" in
      png) m=image/png ;;
      jpg|jpeg) m=image/jpeg ;;
      gif) m=image/gif ;;
      webp) m=image/webp ;;
      pdf) m=application/pdf ;;
      mp4) m=video/mp4 ;;
      webm) m=video/webm ;;
      mov|qt) m=video/quicktime ;;
      txt) m=text/plain ;;
      md|markdown) m=text/markdown ;;
      *) m=application/octet-stream ;;
    esac
  fi
  printf '%s' "$m"
}

kind=""; id=""; files=()
while [ $# -gt 0 ]; do
  case "$1" in
    --issue) kind="issues"; id="\${2:-}"; shift 2 ;;
    --comment) kind="comments"; id="\${2:-}"; shift 2 ;;
    -h|--help) echo "usage: mcp-media-upload.sh --issue <id> | --comment <id>  file [file ...]"; exit 0 ;;
    --) shift; files+=("$@"); break ;;
    -*) die "unknown flag: $1 (use --issue <id> or --comment <id>)" ;;
    *) files+=("$1"); shift ;;
  esac
done

[ -n "$kind" ] || die "specify --issue <id> or --comment <id>"
[ -n "$id" ] || die "missing id after the target flag"
[ "\${#files[@]}" -gt 0 ] || die "no files given"
: "\${FORGE_URL:?set FORGE_URL, e.g. https://api.example.com}"
: "\${FORGE_TOKEN:?set FORGE_TOKEN (same bearer token your MCP client uses)}"

endpoint="\${FORGE_URL%/}/api/$kind/$id/attachments"
rc=0
for f in "\${files[@]}"; do
  [ -f "$f" ] || { echo "mcp-media-upload: not a file: $f" >&2; rc=1; continue; }
  mime="$(guess_mime "$f")"
  if curl -fsS -X POST "$endpoint" -H "Authorization: Bearer $FORGE_TOKEN" -F "file=@\${f};type=\${mime}"; then
    echo
  else
    echo "mcp-media-upload: upload failed for $f" >&2; rc=1
  fi
done
exit $rc
`;

/**
 * Public (unauthenticated) route. The script body carries no secrets — the
 * bearer token is supplied by the caller's env at run time — so serving it
 * openly lets an agent fetch + pipe it in one line.
 */
export const mcpMediaUploadRoutes = new Hono();
mcpMediaUploadRoutes.get('/mcp-media-upload.sh', (c) => {
  c.header('Content-Type', 'text/x-shellscript; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(MCP_MEDIA_UPLOAD_SH);
});
