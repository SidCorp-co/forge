import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Hono } from 'hono';
import { getPublishedRunnerBuild, RELEASE_DIR } from './published-build.js';

export const installRoutes = new Hono();

/** What a box with no credential yet fetches, at either mount: every route here but none behind it. */
export const PUBLIC_INSTALL_PATHS = [
  '/install.sh',
  '/install-plugin.sh',
  '/install/latest.json',
  '/install/bin/:target',
] as const;

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

// No `${}` in these templates but FETCH_SH's — each must survive verbatim to the shell. Only the
// __BASE__ + __PREFIX__ placeholders are substituted (origin + mount prefix).

// How both install scripts fetch: the limits on each request, a failure told apart from a refusal,
// and the server's reason read out of its answer. It needs $tmp, the script's scratch directory.
const FETCH_SH = `# Every request gives up on a connection that has not opened in connect_limit seconds, or that has
# gone quiet (nothing received) for stall_limit seconds. A slow download that is still moving is
# never cut, so no overall limit is set.
connect_limit=30
stall_limit=30
# curl runs outside any pipe, so its own exit status is the one checked. fetch <url> <file> [more
# curl arguments] returns 1 when no HTTP answer came back (refused, DNS, a limit above reached,
# dropped), with $rc and $why keeping what failed, and 2 when the server answered with an HTTP
# error, with $status and $said naming the status and its reason.
fetch() {
  url=$1; out=$2; shift 2
  if meta=$(curl -sSL --connect-timeout "$connect_limit" --speed-limit 1 --speed-time "$stall_limit" \\
    -o "$out" -w '%{http_code} %{num_connects} %{content_type}' "$@" "$url" 2>"$tmp/curl.err"); then :; else
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
  body=$(tr -d '\\r\\n' <"$out" | cut -c1-2000)
  code=$(jstr code)
  reason=$(jstr error)
  [ -n "$reason" ] || reason=$(jstr detail)
  if [ -n "$code" ] && [ -n "$reason" ]; then reason="$code: $reason"; elif [ -n "$code" ]; then reason=$code; fi
  if [ -z "$reason" ]; then
    case "$(printf '%s' "$meta" | cut -d' ' -f3-)" in
      text/plain*) reason=$(head -n 1 "$out" | tr -d '\\r' | cut -c1-200);;
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
`;

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
${FETCH_SH}# The box reached the server, so the answer is the server's to change, not this box's network.
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

// REQ-25 BC-4: the forge plugin (its CLI, hooks and skills) on a machine with one command, holding only
// a Forge token. The plugin's source is private, so the archive is fetched with the token; this script
// is public and carries nothing a token opens. Run again, it updates what it installed.
const INSTALL_PLUGIN_SH = `#!/bin/sh
set -e
BASE="__BASE__"
tokens="$BASE/settings?tab=tokens"
# The token is passed as --token <token>, or typed at the prompt, which does not echo it.
TOKEN=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --token)
      [ "$#" -ge 2 ] || { echo "INSTALL_PLUGIN_USAGE: --token takes the token after it, as --token <token>; nothing was installed." >&2; exit 1; }
      TOKEN=$2; shift 2;;
    --token=*) TOKEN=$(printf '%s' "$1" | cut -d= -f2-); shift;;
    *) printf '%s\\n' "INSTALL_PLUGIN_USAGE: $1 is not an option of this install, which takes --token <token> or asks for one; nothing was installed." >&2; exit 1;;
  esac
done
missing=""
for tool in claude node tar curl; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  echo "INSTALL_PLUGIN_TOOL_MISSING: this machine has no$missing on its PATH. The forge plugin runs in Claude Code (claude) on node, and this install needs tar and curl; install what is missing, then run the install command again. Nothing was installed." >&2
  exit 1
fi
tmp=$(mktemp -d)
echoing=1
leave() {
  [ "$echoing" = 1 ] || stty echo </dev/tty 2>/dev/null || true
  rm -rf "$tmp"
}
trap leave EXIT
trap 'exit 1' INT TERM
if [ -z "$TOKEN" ] && (exec </dev/tty) 2>/dev/null; then
  printf 'Forge token (from %s): ' "$tokens" >/dev/tty
  echoing=0
  stty -echo </dev/tty 2>/dev/null || true
  IFS= read -r TOKEN </dev/tty || TOKEN=""
  stty echo </dev/tty 2>/dev/null || true
  echoing=1
  printf '\\n' >/dev/tty
fi
if [ -z "$TOKEN" ]; then
  echo "INSTALL_PLUGIN_TOKEN_MISSING: no Forge token was given, and there is no terminal to ask for one; run the install command again with --token <token>, a token made under Settings → API Tokens at $tokens. Nothing was installed." >&2
  exit 1
fi
case "$TOKEN" in
  forge_pat_*) ;;
  *) echo "INSTALL_PLUGIN_TOKEN_MALFORMED: what was given is not a Forge token, which starts with forge_pat_; make one under Settings → API Tokens at $tokens and pass it whole. Nothing was installed." >&2; exit 1;;
esac
${FETCH_SH}admin="This machine reached $BASE, so its network is not the cause: show this message to your Forge admin."
# The token rides in a header file only this user can read, never on curl's command line.
(umask 077 && printf 'Authorization: Bearer %s\\n' "$TOKEN" >"$tmp/auth")
archive="$BASE/api/install/plugin.tar.gz"
echo "Downloading the forge plugin from $archive..."
got=0; fetch "$archive" "$tmp/plugin.tar.gz" -H "@$tmp/auth" || got=$?
case "$got" in
  1) printf '%s\\n' "INSTALL_PLUGIN_DOWNLOAD_FAILED: could not download $archive (curl exit $rc: $why); nothing was installed. Check that this machine can reach $BASE, then run the install command again." >&2; exit 1;;
  2)
    case "$status" in
      401) printf '%s\\n' "INSTALL_PLUGIN_TOKEN_REFUSED: $BASE refused the token $said; nothing was installed. Make a token under Settings → API Tokens at $tokens, then run the install command again with it." >&2;;
      *) printf '%s\\n' "INSTALL_PLUGIN_DOWNLOAD_REFUSED: $BASE answered the download of $archive $said; nothing was installed. $admin" >&2;;
    esac
    exit 1;;
esac
mkdir "$tmp/plugin"
if ! tar -xzf "$tmp/plugin.tar.gz" -C "$tmp/plugin" 2>"$tmp/tar.err"; then
  printf '%s\\n' "INSTALL_PLUGIN_ARCHIVE_UNREADABLE: the archive $BASE served does not unpack ($(head -n 1 "$tmp/tar.err")); nothing was installed. $admin" >&2
  exit 1
fi
# The marketplace's own name, read from what was served, never assumed.
name=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(typeof m.name==="string"&&/^[A-Za-z0-9_.-]+$/.test(m.name))process.stdout.write(m.name)' "$tmp/plugin/.claude-plugin/marketplace.json" </dev/null 2>/dev/null) || name=""
if [ -z "$name" ] || [ ! -d "$tmp/plugin/plugin" ]; then
  echo "INSTALL_PLUGIN_ARCHIVE_UNREADABLE: the archive $BASE served holds no plugin marketplace (a .claude-plugin/marketplace.json naming it, beside plugin/); nothing was installed. $admin" >&2
  exit 1
fi
# The entry of a JSON list on stdin whose field $1 is $2, its field $3 printed; nothing where none is.
pick() {
  node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const [k,v,f]=process.argv.slice(1);const l=JSON.parse(s);const m=(Array.isArray(l)?l:[]).find((x)=>x&&x[k]===v);if(m&&m[f]!=null)process.stdout.write(String(m[f]))})' "$@"
}
# pick over what \`claude plugin ... list --json\` answered ($1), or a refusal where it is no JSON list.
# Called inside $(), so its exit ends only that subshell, and the assignment it feeds ends the script.
listed_entry() {
  printf '%s' "$1" | pick "$2" "$3" "$4" 2>/dev/null && return 0
  echo "INSTALL_PLUGIN_CLAUDE_FAILED: Claude Code did not list its $5 as JSON. $done_so_far Update Claude Code, then run the install command again." >&2
  exit 1
}
# One claude call, its stdin kept off this script, which may be the pipe it is being read from.
claude_says() {
  claude "$@" </dev/null 2>"$tmp/claude.err" && return 0
  rc=$?
  why=$(tr '\\n' ' ' <"$tmp/claude.err" | sed 's/ *$//' | cut -c1-300)
  printf '%s\\n' "INSTALL_PLUGIN_CLAUDE_FAILED: \\\`claude $*\\\` failed (exit $rc: $why). $done_so_far Deal with what Claude Code said, then run the install command again." >&2
  exit 1
}
dest="$HOME/.forge/plugin"
done_so_far="Nothing was installed."
listed=$(claude_says plugin marketplace list --json)
where=$(listed_entry "$listed" name "$name" installLocation marketplaces)
if [ -n "$where" ] && [ "$where" != "$dest" ]; then
  printf '%s\\n' "INSTALL_PLUGIN_MARKETPLACE_ELSEWHERE: Claude Code already has a marketplace named $name, from $where, and this install keeps its copy at $dest; it does not take that name over. Remove the other one (claude plugin marketplace remove $name), then run the install command again. Nothing was installed." >&2
  exit 1
fi
# Placed only once the archive is whole, and swapped in by rename, so a refusal leaves what was there.
mkdir -p "$HOME/.forge"
rm -rf "$dest.new" "$dest.old"
mv "$tmp/plugin" "$dest.new"
[ ! -d "$dest" ] || mv "$dest" "$dest.old"
mv "$dest.new" "$dest"
rm -rf "$dest.old"
echo "Unpacked to $dest"
done_so_far="The plugin's files are at $dest."
if [ -n "$where" ]; then claude_says plugin marketplace update "$name" >/dev/null; else claude_says plugin marketplace add "$dest" >/dev/null; fi
plugins=$(claude_says plugin list --json)
installed=$(listed_entry "$plugins" id "forge@$name" id plugins)
if [ -n "$installed" ]; then claude_says plugin update "forge@$name" >/dev/null; else claude_says plugin install "forge@$name" >/dev/null; fi
plugins=$(claude_says plugin list --json)
path=$(listed_entry "$plugins" id "forge@$name" installPath plugins)
if [ -z "$path" ]; then
  echo "INSTALL_PLUGIN_NOT_INSTALLED: Claude Code lists no forge@$name after installing it. $done_so_far Run the install command again; if it ends the same way, show this message to your Forge admin." >&2
  exit 1
fi
version=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version||""))' "$path/.claude-plugin/plugin.json" </dev/null 2>/dev/null) || version=""
echo "Installed forge $version from $name"
# The forge and vi-natural commands, placed in ~/.local/bin now rather than at the next session start.
linked=0; node "$path/hooks/link-cli.mjs" "$path" </dev/null || linked=$?
forge="$HOME/.local/bin/forge"
if [ "$linked" != 0 ] || [ ! -x "$forge" ]; then
  echo "INSTALL_PLUGIN_LINK_FAILED: the plugin is installed, but its link-cli (exit $linked) placed no forge command at $forge. Start a Claude Code session, which places it, then run: forge doctor --url $BASE --token <token>" >&2
  exit 1
fi
# Saves this machine's account, the endpoint and the token, in the plugin's own config, then checks it,
# with the forge just placed on the PATH, as the line printed below tells the person to set it.
doctored=0; PATH="$HOME/.local/bin:$PATH" "$forge" doctor --url "$BASE" --token "$TOKEN" </dev/null || doctored=$?
if [ "$doctored" != 0 ]; then
  echo "INSTALL_PLUGIN_DOCTOR_FAILED: forge $version is installed, and forge doctor (exit $doctored) names above what this machine still lacks; run forge doctor again once that is done." >&2
  exit 1
fi
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "Add to PATH:  export PATH=\\"$HOME/.local/bin:\\$PATH\\"";;
esac
echo "Done. A new Claude Code session loads the forge plugin."
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

installRoutes.get('/install-plugin.sh', (c) =>
  c.body(INSTALL_PLUGIN_SH.replace(/__BASE__/g, origin(c.req.url)), 200, {
    'content-type': 'text/x-shellscript; charset=utf-8',
  }),
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
