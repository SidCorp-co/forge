import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';
import { refreshMainRunnerHead } from './main-runner-head.js';
import {
  downloadReleaseAsset,
  listRepoReleases,
  type PublicRelease as Release,
} from './public-releases.js';

const REPO = process.env.RUNNER_RELEASE_REPO ?? 'SidCorp-co/forge';
const TAG_PREFIX = 'runner-v';
const ASSET_PREFIX = 'forge-runner-';
// Published beside VERSION by runner-release.yml: what tells two builds that share
// a version number apart.
const COMMIT_ASSET = 'COMMIT';

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
function tagToVersion(tag: string): string {
  return tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : tag;
}

/**
 * Pick the highest-semver published `runner-v*` release, ignoring drafts,
 * prereleases, and non-`runner-v` tags. Returns null when none qualify. Pure —
 * unit-tested in fetch-release.test.ts.
 */
function pickLatestRunnerTag(releases: Release[]): Release | null {
  const runner = releases.filter(
    (r) => !r.draft && !r.prerelease && r.tag_name.startsWith(TAG_PREFIX),
  );
  if (runner.length === 0) return null;
  return runner.reduce((best, r) =>
    cmpVersion(tagToVersion(r.tag_name), tagToVersion(best.tag_name)) > 0 ? r : best,
  );
}

/** The release's `COMMIT` asset, trimmed, or null where it published none. */
async function fetchCommitAsset(release: Release): Promise<string | null> {
  const asset = release.assets.find((a) => a.name === COMMIT_ASSET);
  if (!asset) return null;
  const got = await downloadReleaseAsset(asset.browser_download_url);
  if (!got.ok) throw new Error(`download ${COMMIT_ASSET}: ${got.status}`);
  return got.bytes.toString('utf8').trim() || null;
}

async function latestRunnerRelease(): Promise<Release | null> {
  return pickLatestRunnerTag(await listRepoReleases(REPO));
}

async function run(): Promise<void> {
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
    const got = await downloadReleaseAsset(asset.browser_download_url);
    if (!got.ok) throw new Error(`download ${asset.name}: ${got.status}`);
    const buf = got.bytes;
    // Write to a temp name then rename so a crash mid-download can't leave a
    // truncated binary that the install route would serve + hash.
    const tmp = join(dir, `${asset.name}.tmp`);
    await writeFile(tmp, buf, { mode: 0o755 });
    await rename(tmp, join(dir, asset.name));
    console.log(`[runner-release] fetched ${asset.name} (${buf.length} bytes)`);
  }

  // A stale COMMIT beside a fresh VERSION is an identity belonging to neither, and
  // every box would be compared against a commit nothing shipped.
  const commit = await fetchCommitAsset(release);
  if (commit) {
    await writeFile(join(dir, COMMIT_ASSET), `${commit}\n`, 'utf8');
  } else {
    await rm(join(dir, COMMIT_ASSET), { force: true });
    console.log(`[runner-release] ${release.tag_name} published no ${COMMIT_ASSET} asset`);
  }

  // Write VERSION last — the install route keys "published?" off this file.
  await writeFile(join(dir, 'VERSION'), `${version}\n`, 'utf8');
  console.log(`[runner-release] published runner ${version} (${commit ?? 'no commit'}) to ${dir}`);
}

/** Whether this core serves runner builds from its own disk, and so keeps them fresh. */
export function servesRunnerReleases(): boolean {
  return Boolean(process.env.RUNNER_RELEASE_DIR);
}

/**
 * The process timer (`timer-registry.ts`): `main`'s runner head rides the same tick, the other half
 * of what a box is compared against, read once per tick rather than per request.
 */
export async function refetchRunnerRelease(): Promise<void> {
  await refreshMainRunnerHead();
  await run().catch((err) => {
    console.warn(
      `[runner-release] periodic refetch skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

// Only run when invoked directly (`node dist/integrations/published-releases/fetch-release.js`), not
// when imported by the unit tests — otherwise importing the pure helpers would
// trigger a live GitHub fetch and `process.exit(0)`.
const isMain = argv[1] && import.meta.url === pathToFileURL(argv[1]).href;
if (isMain) {
  run()
    .catch((err) => {
      // Never block core boot on a release-fetch failure.
      console.warn(`[runner-release] skipped: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      // Explicit clean exit so `&&` in the container CMD proceeds to the server.
      process.exit(0);
    });
}
