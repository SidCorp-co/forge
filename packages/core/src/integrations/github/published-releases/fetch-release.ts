import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';
import { channelOfVersion, type RunnerReleaseChannel, servedRunnerChannel } from './channel.js';
import { refreshChannelRunnerHead } from './channel-runner-head.js';
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

/** How far down GitHub's newest-first release list a channel's newest release is looked for. */
const MAX_PAGES = 5;

/**
 * The ordering key of a version: X.Y.Z as numbers, then its rank among builds of that X.Y.Z — a
 * pre-release such as `-rc.1` below the release, and a dev-line build `-dev.N` ABOVE it, because a
 * dev build is that release plus what landed on `dev` since (ISS-1358) — then the pre-release's
 * identifiers, numeric ones as numbers and below alphanumeric ones. The runner orders versions the
 * same way (`runner-update`'s `is_newer`).
 */
function precedence(v: string): { xyz: number[]; rank: number; idents: (number | string)[] } {
  const bare = (v.trim().replace(/^v/, '').split('+')[0] ?? '').trim();
  const dash = bare.indexOf('-');
  const core = dash === -1 ? bare : bare.slice(0, dash);
  const pre = dash === -1 ? null : bare.slice(dash + 1);
  const xyz = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const idents = (pre ?? '')
    .split('.')
    .filter((p) => p !== '')
    .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const rank = pre === null ? 1 : idents[0] === 'dev' ? 2 : 0;
  return { xyz, rank, idents };
}

function cmpIdent(a: number | string | undefined, b: number | string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a < b ? -1 : 1;
}

/** Compare two versions by [`precedence`]; >0 if a>b, <0 if a<b, 0 if equal. */
export function cmpVersion(a: string, b: string): number {
  const pa = precedence(a);
  const pb = precedence(b);
  for (let i = 0; i < Math.max(pa.xyz.length, pb.xyz.length, 3); i++) {
    const d = (pa.xyz[i] ?? 0) - (pb.xyz[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.rank !== pb.rank) return pa.rank - pb.rank;
  for (let i = 0; i < Math.max(pa.idents.length, pb.idents.length); i++) {
    const d = cmpIdent(pa.idents[i], pb.idents[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/** Strip the `runner-v` tag prefix to the bare version, e.g. `runner-v0.2.11` → `0.2.11`. */
function tagToVersion(tag: string): string {
  return tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : tag;
}

/**
 * Whether `r` is a release of `channel`'s line: on `main`, a published `runner-vX.Y.Z`; on `dev`, a
 * published prerelease `runner-vX.Y.Z-dev.N`. Drafts and every other tag are on neither.
 */
function onChannel(r: Release, channel: RunnerReleaseChannel): boolean {
  if (r.draft || !r.tag_name.startsWith(TAG_PREFIX)) return false;
  const line = channelOfVersion(tagToVersion(r.tag_name));
  return channel === 'dev' ? r.prerelease && line === 'dev' : !r.prerelease && line === 'main';
}

/** The highest-versioned release of `channel`'s line in `releases`, or null when none is. */
export function pickLatestRunnerRelease(
  releases: Release[],
  channel: RunnerReleaseChannel,
): Release | null {
  const runner = releases.filter((r) => onChannel(r, channel));
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

/**
 * The newest release of `channel`'s line, read page by page down GitHub's newest-first list: dev
 * prereleases are cut far more often than `main`'s releases and would push them off one page.
 */
async function latestRunnerRelease(channel: RunnerReleaseChannel): Promise<Release | null> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const releases = await listRepoReleases(REPO, page);
    const picked = pickLatestRunnerRelease(releases, channel);
    if (picked !== null || releases.length === 0) return picked;
  }
  return null;
}

/**
 * Whether the build on disk already answers for `channel`: the same version, or a higher one of
 * the same line, so a stale read never moves a line backwards. A build of the other line is
 * replaced, which is what switching a core's channel means.
 */
function servesAlready(current: string, version: string, channel: RunnerReleaseChannel): boolean {
  if (current === version) return true;
  return channelOfVersion(current) === channel && cmpVersion(current, version) >= 0;
}

async function run(): Promise<void> {
  const dir = process.env.RUNNER_RELEASE_DIR;
  if (!dir) {
    console.log('[runner-release] RUNNER_RELEASE_DIR unset — skipping runner asset fetch');
    return;
  }

  const channel = servedRunnerChannel();
  const release = await latestRunnerRelease(channel);
  if (!release) {
    console.log(
      `[runner-release] no published ${channel}-channel runner-v* release found — skipping`,
    );
    return;
  }
  const version = tagToVersion(release.tag_name);

  const current = await readFile(join(dir, 'VERSION'), 'utf8')
    .then((s) => s.trim())
    .catch(() => '');
  if (current && servesAlready(current, version, channel)) {
    console.log(
      `[runner-release] up to date (have ${current}, latest ${channel} ${version}) — skipping`,
    );
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
  console.log(
    `[runner-release] published ${channel}-channel runner ${version} (${commit ?? 'no commit'}) to ${dir}`,
  );
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
  await refreshChannelRunnerHead();
  await run().catch((err: unknown) => {
    console.warn(
      `[runner-release] periodic refetch skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

// Only run when invoked directly (`node dist/integrations/github/published-releases/fetch-release.js`), not
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
