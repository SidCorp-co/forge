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
for arg in "$@"; do
  case "$arg" in
    --no-auto-update) AUTO_UPDATE=0;;
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
mkdir -p "$dest"
# Read what core publishes first: a platform with no build is refused by name, never a bare 404.
manifest=$(curl -fsSL "$BASE$PREFIX/install/latest.json" | tr -d ' \\n')
published=$(printf '%s' "$manifest" | grep -o '"[^"]*":{"url"' | sed 's/":{"url"//; s/"//g' | tr '\\n' ' ')
case " $published " in
  *" $target "*) ;;
  *) echo "INSTALL_PLATFORM_UNPUBLISHED: no forge-runner build is published for $target ($os $arch); published: $published. Nothing was installed." >&2; exit 1;;
esac
echo "Downloading forge-runner ($target)..."
curl -fsSL "$BASE$PREFIX/install/bin/$target" -o "$dest/forge-runner.new"
# Refuse by name unless the download matches the sha256 core publishes for this target.
want=$(printf '%s' "$manifest" | sed -n 's/.*"'"$target"'":{[^}]*"sha256":"\\([0-9a-f]*\\)".*/\\1/p')
[ -n "$want" ] || { rm -f "$dest/forge-runner.new"; echo "INSTALL_SHA256_UNPUBLISHED: core publishes no sha256 for $target, so the download cannot be verified; nothing was installed." >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$dest/forge-runner.new" | cut -d' ' -f1); else got=$(shasum -a 256 "$dest/forge-runner.new" | cut -d' ' -f1); fi
[ "$got" = "$want" ] || { rm -f "$dest/forge-runner.new"; echo "INSTALL_SHA256_MISMATCH: forge-runner for $target hashed $got, core publishes $want; nothing was installed." >&2; exit 1; }
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
echo "Next:  forge-runner setup"
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
