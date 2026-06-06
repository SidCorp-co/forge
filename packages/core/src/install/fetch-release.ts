/**
 * Boot-time populate of `RUNNER_RELEASE_DIR` from the latest `runner-v*` GitHub
 * Release (ISS-310). The install routes (`install/routes.ts`) serve whatever
 * `forge-runner-<target>` + `VERSION` files live in that dir; CI publishes the
 * assets to a GitHub Release but nothing copied them onto the core host, so the
 * `/install/*` endpoints 501'd and `forge-runner update` had nothing to pull.
 *
 * This script runs once before the server starts (see the Dockerfile CMD). It
 * is BEST-EFFORT: any failure (no network, rate-limit, no release) logs and
 * exits 0 so it can never block core boot. Idempotent: skips the download when
 * the local `VERSION` already matches the latest published tag.
 *
 * Repo `SidCorp-co/forge` is public, so the GitHub API + asset downloads work
 * unauthenticated; `GITHUB_TOKEN` is used only to raise the rate limit if set.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

const REPO = process.env.RUNNER_RELEASE_REPO ?? 'SidCorp-co/forge';
const TAG_PREFIX = 'runner-v';
const ASSET_PREFIX = 'forge-runner-';

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}
interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'user-agent': 'forge-core-release-fetch',
    accept: 'application/vnd.github+json',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/** Compare two dotted numeric versions; >0 if a>b, <0 if a<b, 0 if equal. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Strip the `runner-v` tag prefix to the bare version, e.g. `runner-v0.2.11` → `0.2.11`. */
export function tagToVersion(tag: string): string {
  return tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : tag;
}

/**
 * Pick the highest-semver published `runner-v*` release, ignoring drafts,
 * prereleases, and non-`runner-v` tags. Returns null when none qualify. Pure —
 * unit-tested in fetch-release.test.ts.
 */
export function pickLatestRunnerTag(releases: Release[]): Release | null {
  const runner = releases.filter(
    (r) => !r.draft && !r.prerelease && r.tag_name.startsWith(TAG_PREFIX),
  );
  if (runner.length === 0) return null;
  return runner.reduce((best, r) =>
    cmpVersion(tagToVersion(r.tag_name), tagToVersion(best.tag_name)) > 0 ? r : best,
  );
}

async function latestRunnerRelease(): Promise<Release | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, {
    headers: ghHeaders(),
  });
  if (!res.ok) throw new Error(`GitHub releases API ${res.status}`);
  const all = (await res.json()) as Release[];
  return pickLatestRunnerTag(all);
}

export async function run(): Promise<void> {
  const dir = process.env.RUNNER_RELEASE_DIR;
  if (!dir) {
    console.log('[runner-release] RUNNER_RELEASE_DIR unset — skipping runner asset fetch');
    return;
  }

  const release = await latestRunnerRelease();
  if (!release) {
    console.log('[runner-release] no published runner-v* release found — skipping');
    return;
  }
  const version = tagToVersion(release.tag_name);

  const current = await readFile(join(dir, 'VERSION'), 'utf8')
    .then((s) => s.trim())
    .catch(() => '');
  if (current && cmpVersion(current, version) >= 0) {
    console.log(`[runner-release] up to date (have ${current}, latest ${version}) — skipping`);
    return;
  }

  await mkdir(dir, { recursive: true });
  const assets = release.assets.filter((a) => a.name.startsWith(ASSET_PREFIX));
  if (assets.length === 0) {
    console.log(`[runner-release] ${release.tag_name} has no ${ASSET_PREFIX}* assets — skipping`);
    return;
  }

  for (const asset of assets) {
    const res = await fetch(asset.browser_download_url, {
      headers: { 'user-agent': 'forge-core-release-fetch' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`download ${asset.name}: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // Write to a temp name then rename so a crash mid-download can't leave a
    // truncated binary that the install route would serve + hash.
    const tmp = join(dir, `${asset.name}.tmp`);
    await writeFile(tmp, buf, { mode: 0o755 });
    await rename(tmp, join(dir, asset.name));
    console.log(`[runner-release] fetched ${asset.name} (${buf.length} bytes)`);
  }
  // Write VERSION last — the install route keys "published?" off this file.
  await writeFile(join(dir, 'VERSION'), `${version}\n`, 'utf8');
  console.log(`[runner-release] published runner ${version} to ${dir}`);
}

/**
 * Periodic re-ingest (ISS-392). `run()` otherwise fires only once at boot (the
 * Dockerfile CMD), so a freshly cut `runner-v*` release is not served — and
 * therefore not auto-pulled by runners — until the next core restart. Schedule
 * a low-frequency re-fetch so auto-update delivery does not depend on a manual
 * redeploy. No-op when RUNNER_RELEASE_DIR is unset. The timer is unref'd so it
 * never keeps the process alive on shutdown; each tick is best-effort (a failed
 * fetch logs and is retried next interval, never throwing into the caller).
 */
export function registerRunnerReleaseRefetch(intervalMs = 30 * 60_000): NodeJS.Timeout | null {
  if (!process.env.RUNNER_RELEASE_DIR) return null;
  const timer = setInterval(() => {
    void run().catch((err) => {
      console.warn(
        `[runner-release] periodic refetch skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
}

// Only run when invoked directly (`node dist/install/fetch-release.js`), not
// when imported by the unit tests — otherwise importing the pure helpers would
// trigger a live GitHub fetch and `process.exit(0)`.
const isMain = argv[1] && import.meta.url === pathToFileURL(argv[1]).href;
if (isMain) {
  run()
    .catch((err) => {
      // Never block core boot on a release-fetch failure.
      console.warn(
        `[runner-release] skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      // Explicit clean exit so `&&` in the container CMD proceeds to the server.
      process.exit(0);
    });
}
