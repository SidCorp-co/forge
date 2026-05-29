import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Hono } from 'hono';

/**
 * Runner distribution: serves the install script, the release manifest, and the
 * binaries the `forge-runner` self-updater consumes. All public (the installer
 * runs before pairing).
 *
 * Binaries live in `RUNNER_RELEASE_DIR`:
 *   <dir>/VERSION                                  e.g. "0.2.10"
 *   <dir>/forge-runner-x86_64-unknown-linux-gnu    (one per target triple)
 *   <dir>/forge-runner-aarch64-apple-darwin
 *
 * The CI release workflow builds these; the deploy populates the dir.
 */
export const installRoutes = new Hono();

const RELEASE_DIR = process.env.RUNNER_RELEASE_DIR ?? '';
const ASSET_PREFIX = 'forge-runner-';

function origin(reqUrl: string): string {
  return new URL(reqUrl).origin;
}

// No `${}` in this template — it must survive verbatim to the shell. Only the
// __BASE__ placeholder is substituted with the core origin.
const INSTALL_SH = `#!/bin/sh
set -e
BASE="__BASE__"
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
  *) echo "Add to PATH:  export PATH=\\"$dest:\\$PATH\\"";;
esac
echo "Next:  forge-runner login --core-url $BASE --code <CODE>"
`;

installRoutes.get('/install.sh', (c) =>
  c.body(INSTALL_SH.replace(/__BASE__/g, origin(c.req.url)), 200, {
    'content-type': 'text/x-shellscript; charset=utf-8',
  }),
);

installRoutes.get('/install/latest.json', async (c) => {
  if (!RELEASE_DIR) return c.json({ error: 'RUNNER_RELEASE_DIR not configured' }, 501);
  let version: string;
  try {
    version = (await readFile(join(RELEASE_DIR, 'VERSION'), 'utf8')).trim();
  } catch {
    return c.json({ error: 'no release published' }, 404);
  }
  const base = origin(c.req.url);
  const files = await readdir(RELEASE_DIR).catch(() => [] as string[]);
  const assets: Record<string, { url: string; sha256: string }> = {};
  for (const f of files) {
    if (!f.startsWith(ASSET_PREFIX)) continue;
    const target = f.slice(ASSET_PREFIX.length);
    const buf = await readFile(join(RELEASE_DIR, f));
    assets[target] = {
      url: `${base}/install/bin/${target}`,
      sha256: createHash('sha256').update(buf).digest('hex'),
    };
  }
  return c.json({ version, assets });
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
    return c.json({ error: 'unknown target' }, 404);
  }
});
