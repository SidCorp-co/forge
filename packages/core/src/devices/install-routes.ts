import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Hono } from 'hono';
import { getPublishedRunnerBuild, RELEASE_DIR } from './published-build.js';

export const installRoutes = new Hono();

const ASSET_PREFIX = 'forge-runner-';

function origin(reqUrl: string): string {
  const u = new URL(reqUrl);
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  if (u.protocol === 'http:' && !loopback) u.protocol = 'https:';
  return u.origin;
}

/**
 * The mount prefix the request arrived through: `/api` when reached via the
 * proxied `/api/install/...` channel, else `''` (direct root mount). Keeps the
 * URLs we hand back on the same channel the caller already reached us on.
 */
function mountPrefix(path: string): string {
  return path.startsWith('/api/') ? '/api' : '';
}

// No `${}` in this template — it must survive verbatim to the shell. Only the
// __BASE__ + __PREFIX__ placeholders are substituted (origin + mount prefix).
const INSTALL_SH = `#!/bin/sh
set -e
BASE="__BASE__"
PREFIX="__PREFIX__"
# Auto-update defaults ON (ISS-392). Pass --no-auto-update to opt this device out.
AUTO_UPDATE=1
# --setup goes straight on to \`forge-runner setup\`, so one pasted command installs and pairs the box.
SETUP=0
for arg in "$@"; do
  case "$arg" in
    --no-auto-update) AUTO_UPDATE=0;;
    --setup) SETUP=1;;
  esac
done
os=$(uname -s); arch=$(uname -m)
case "$os" in
  Linux) plat="unknown-linux-gnu";;
  Darwin) plat="apple-darwin";;
  *) echo "INSTALL_PLATFORM_UNSUPPORTED: forge-runner is built for Linux and macOS, and this box runs $os; nothing was installed." >&2; exit 1;;
esac
case "$arch" in
  x86_64|amd64) cpu="x86_64";;
  aarch64|arm64) cpu="aarch64";;
  *) echo "INSTALL_PLATFORM_UNSUPPORTED: forge-runner is built for x86_64 and aarch64, and this box is $arch ($os); nothing was installed." >&2; exit 1;;
esac
target="$cpu-$plat"
dest="$HOME/.local/bin"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' INT TERM
# Every request gives up on a connection that has not opened in connect_limit seconds, or that has
# gone quiet (nothing received) for stall_limit seconds. A slow download that is still moving is
# never cut, so no overall limit is set.
connect_limit=30
stall_limit=30
# curl runs outside any pipe, so its own exit status is the one checked. fetch returns 1 when no
# HTTP answer came back (refused, DNS, a limit above reached, dropped), with $rc and $why keeping
# what failed, and 2 when the server answered with an HTTP error, with $said naming the status and
# its reason.
fetch() {
  if meta=$(curl -sSL --connect-timeout "$connect_limit" --speed-limit 1 --speed-time "$stall_limit" \\
    -o "$2" -w '%{http_code} %{num_connects} %{content_type}' "$1" 2>"$tmp/curl.err"); then :; else
    rc=$?
    why=$(tr '\\n' ' ' <"$tmp/curl.err" | sed 's/ *$//')
    # curl exit 28 is one of the limits above: name which one ran out, not curl's wording of it.
    if [ "$rc" = 28 ]; then
      case "$(printf '%s' "$meta" | cut -d' ' -f2)" in
        ''|0) why="no connection opened within $connect_limit s, the longest this install waits for one";;
        *) why="the connection went quiet: nothing arrived for $stall_limit s, the longest this install waits on one";;
      esac
    fi
    return 1
  fi
  status=$(printf '%s' "$meta" | cut -d' ' -f1)
  # 000 is a read with no HTTP status at all (a file:// mirror): curl succeeding is the answer.
  case "$status" in 2??|000) return 0;; esac
  # The server's reason: a JSON body's code with its error, or a problem body's code with its
  # detail; else a plain-text body's first line.
  body=$(tr -d '\\r\\n' <"$2" | cut -c1-2000)
  code=$(jstr code)
  reason=$(jstr error)
  [ -n "$reason" ] || reason=$(jstr detail)
  if [ -n "$code" ] && [ -n "$reason" ]; then reason="$code: $reason"; elif [ -n "$code" ]; then reason=$code; fi
  if [ -z "$reason" ]; then
    case "$(printf '%s' "$meta" | cut -d' ' -f3-)" in
      text/plain*) reason=$(head -n 1 "$2" | tr -d '\\r' | cut -c1-200);;
    esac
  fi
  if [ -n "$reason" ]; then said="with HTTP $status: $reason"; else said="with HTTP $status and gave no reason"; fi
  return 2
}
# The string field $1 of the JSON $body, read as a JSON string: an escaped quote does not end it, and
# an escaped quote, backslash or slash reads back as itself.
jstr() {
  printf '%s' "$body" | sed -nE 's/.*"'"$1"'":"(([^"\\\\]|\\\\.)*)".*/\\1/p' | sed -E 's/\\\\(["\\\\/])/\\1/g'
}
# The box reached the server, so the answer is the server's to change, not this box's network.
admin="This box reached $BASE, so its network is not the cause: show this message to your Forge admin."
# Read what core publishes first: a platform with no build is refused by name, never a bare 404.
# A build list that could not be read says nothing about the platform, so it is refused as itself.
list="$BASE$PREFIX/install/latest.json"
# Said before the first wait, so a slow or silent server never leaves an empty terminal. A refusal
# carrying what curl or the server said is written with printf: sh's echo may read a backslash in it.
echo "Reading the forge-runner builds published at $list..."
got=0; fetch "$list" "$tmp/latest.json" || got=$?
case "$got" in
  1) printf '%s\\n' "INSTALL_BUILD_LIST_UNREACHABLE: could not read the published build list at $list (curl exit $rc: $why); this box's platform ($target) was not checked and nothing was installed. Check that this box can reach $BASE, then run the install command again." >&2; exit 1;;
  2) printf '%s\\n' "INSTALL_BUILD_LIST_REFUSED: $BASE answered the build list request at $list $said; this box's platform ($target) was not checked and nothing was installed. $admin" >&2; exit 1;;
esac
manifest=$(tr -d ' \\n' <"$tmp/latest.json")
case "$manifest" in
  *'"assets":{'*) ;;
  *) echo "INSTALL_BUILD_LIST_UNREADABLE: $list answered, but not with a forge-runner build list; this box's platform ($target) was not checked and nothing was installed. Check that $BASE is the Forge you meant to install from, then run the install command again." >&2; exit 1;;
esac
published=$(printf '%s' "$manifest" | grep -o '"[^"]*":{"url"' | sed 's/":{"url"//; s/"//g' | paste -sd, - | sed 's/,/, /g')
[ -n "$published" ] || published=none
case ", $published, " in
  *", $target, "*) ;;
  *) echo "INSTALL_PLATFORM_UNPUBLISHED: no forge-runner build is published for $target ($os $arch); published: $published. Nothing was installed." >&2; exit 1;;
esac
want=$(printf '%s' "$manifest" | sed -n 's/.*"'"$target"'":{[^}]*"sha256":"\\([0-9a-f]*\\)".*/\\1/p')
[ -n "$want" ] || { echo "INSTALL_SHA256_UNPUBLISHED: core publishes no sha256 for $target, so the download cannot be verified; nothing was installed." >&2; exit 1; }
echo "Downloading forge-runner ($target)..."
bin="$BASE$PREFIX/install/bin/$target"
got=0; fetch "$bin" "$tmp/forge-runner" || got=$?
case "$got" in
  1) printf '%s\\n' "INSTALL_DOWNLOAD_FAILED: could not download $bin (curl exit $rc: $why); nothing was installed. Check that this box can reach $BASE, then run the install command again." >&2; exit 1;;
  2) printf '%s\\n' "INSTALL_DOWNLOAD_REFUSED: $BASE answered the download of $bin $said; nothing was installed. $admin" >&2; exit 1;;
esac
# Refuse by name unless the download matches the sha256 core publishes for this target.
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/forge-runner" | cut -d' ' -f1); else got=$(shasum -a 256 "$tmp/forge-runner" | cut -d' ' -f1); fi
[ "$got" = "$want" ] || { echo "INSTALL_SHA256_MISMATCH: forge-runner for $target hashed $got, core publishes $want; nothing was installed. Run the install command again; if it fails the same way, something between this box and $BASE is changing the download, so tell your Forge admin." >&2; exit 1; }
# Made only once a verified build is in hand, so a refusal leaves nothing behind.
mkdir -p "$dest"
mv "$tmp/forge-runner" "$dest/forge-runner.new"
chmod +x "$dest/forge-runner.new"
mv "$dest/forge-runner.new" "$dest/forge-runner"
echo "Installed to $dest/forge-runner"
# The script knows which core it was served by, so the binary should not have
# to be told again: write it once here and \`forge-runner login\` needs no flag.
"$dest/forge-runner" config set core-url "$BASE" >/dev/null 2>&1 \
  && echo "Core URL set to $BASE" \
  || echo "Could not write the core URL — pass --core-url $BASE to login." >&2
if [ "$AUTO_UPDATE" = "0" ]; then
  "$dest/forge-runner" config set update.auto false || true
  echo "Auto-update disabled for this device."
else
  echo "Auto-update is ON (disable later with: forge-runner config set update.auto false)"
fi
case ":$PATH:" in
  *":$dest:"*) ;;
  *) echo "Add to PATH:  export PATH=\\"$dest:\\$PATH\\"";;
esac
if [ "$SETUP" = "0" ]; then
  echo "Next:  forge-runner setup"
  exit 0
fi
echo "Running forge-runner setup"
# exec replaces this shell, so its exit trap never runs: the scratch goes first
rm -rf "$tmp"
trap - EXIT
# piped into sh, stdin is this script, so setup reads the terminal where there is one
if (exec </dev/tty) 2>/dev/null; then
  exec "$dest/forge-runner" setup </dev/tty
fi
exec "$dest/forge-runner" setup
`;

// Served when RUNNER_RELEASE_DIR is unset: the download script above would
// `curl` /install/bin/:target and hit an opaque 501. Print a clear message and
// exit non-zero instead, so `curl … | sh` fails loudly rather than silently.
const INSTALL_SH_UNPUBLISHED = `#!/bin/sh
echo "forge-runner release has not been published yet." >&2
echo "Ask the operator to set RUNNER_RELEASE_DIR on the core server." >&2
exit 1
`;

installRoutes.get('/install.sh', (c) =>
  c.body(
    RELEASE_DIR
      ? INSTALL_SH.replace(/__BASE__/g, origin(c.req.url)).replace(
          /__PREFIX__/g,
          mountPrefix(c.req.path),
        )
      : INSTALL_SH_UNPUBLISHED,
    200,
    { 'content-type': 'text/x-shellscript; charset=utf-8' },
  ),
);

installRoutes.get('/install/latest.json', async (c) => {
  if (!RELEASE_DIR) return c.json({ error: 'RUNNER_RELEASE_DIR not configured' }, 501);
  const published = await getPublishedRunnerBuild();
  if (!published) return c.json({ error: 'no release published' }, 404);
  const { version, commit } = published;
  const base = origin(c.req.url);
  const prefix = mountPrefix(c.req.path);
  const files = await readdir(RELEASE_DIR).catch(() => [] as string[]);
  const assets: Record<string, { url: string; sha256: string }> = {};
  for (const f of files) {
    if (!f.startsWith(ASSET_PREFIX)) continue;
    const target = f.slice(ASSET_PREFIX.length);
    const buf = await readFile(join(RELEASE_DIR, f));
    assets[target] = {
      url: `${base}${prefix}/install/bin/${target}`,
      sha256: createHash('sha256').update(buf).digest('hex'),
    };
  }
  // `commit` is omitted rather than null where the release recorded none, so a
  // reader cannot mistake "this release did not say" for "this release has no
  // commit".
  return c.json(commit === null ? { version, assets } : { version, commit, assets });
});

installRoutes.get('/install/bin/:target', async (c) => {
  if (!RELEASE_DIR) return c.json({ error: 'RUNNER_RELEASE_DIR not configured' }, 501);
  const target = c.req.param('target').replace(/[^a-zA-Z0-9._-]/g, '');
  try {
    const buf = await readFile(join(RELEASE_DIR, `${ASSET_PREFIX}${target}`));
    return c.body(buf, 200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="forge-runner-${target}"`,
    });
  } catch {
    const files = await readdir(RELEASE_DIR).catch(() => [] as string[]);
    const published = files
      .filter((f) => f.startsWith(ASSET_PREFIX))
      .map((f) => f.slice(ASSET_PREFIX.length));
    return c.json(
      {
        code: 'INSTALL_PLATFORM_UNPUBLISHED',
        error: `no forge-runner build is published for ${target}; published: ${published.join(', ') || 'none'}`,
      },
      404,
    );
  }
});
