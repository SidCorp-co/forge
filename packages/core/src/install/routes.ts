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
 *
 * Mounting (ISS-392): these routes are mounted at BOTH the core root (`/…`, for
 * self-hosters who expose core directly) AND under `/api/…` (in `index.ts`). On
 * the hosted deploy the edge proxy forwards only `/api/*` to core, so a runner
 * reaching `{core}/install/latest.json` at the root 404s into the web app — the
 * runner therefore fetches `{core}/api/install/latest.json`. The generated
 * download URLs (manifest asset `url`, install.sh's `curl`) are PREFIX-AWARE:
 * they echo back whichever prefix the request arrived on, so a request through
 * `/api/...` yields `/api/install/bin/...` (proxy-reachable) while a direct
 * root request keeps the root paths.
 */
export const installRoutes = new Hono();

const RELEASE_DIR = process.env.RUNNER_RELEASE_DIR ?? '';
const ASSET_PREFIX = 'forge-runner-';

function origin(reqUrl: string): string {
  return new URL(reqUrl).origin;
}

/**
 * The mount prefix the request arrived through: `/api` when reached via the
 * proxied `/api/install/...` channel, else `''` (direct root mount). Keeps the
 * URLs we hand back on the same channel the caller already reached us on.
 */
function mountPrefix(path: string): string {
  return path.startsWith('/api/') ? '/api' : '';
}

/**
 * Latest published runner version (the `VERSION` file in `RUNNER_RELEASE_DIR`),
 * or null when nothing is published / the dir is unset. Exported so the devices
 * routes can flag runners that lag the latest release (ISS-392).
 */
export async function getLatestRunnerVersion(): Promise<string | null> {
  if (!RELEASE_DIR) return null;
  try {
    return (await readFile(join(RELEASE_DIR, 'VERSION'), 'utf8')).trim() || null;
  } catch {
    return null;
  }
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
curl -fsSL "$BASE$PREFIX/install/bin/$target" -o "$dest/forge-runner.new"
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
  *) echo "Add to PATH:  export PATH=\\"$dest:\\$PATH\\"";;
esac
echo "Next:  forge-runner login --core-url $BASE --code <CODE>"
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
  let version: string;
  try {
    version = (await readFile(join(RELEASE_DIR, 'VERSION'), 'utf8')).trim();
  } catch {
    return c.json({ error: 'no release published' }, 404);
  }
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
