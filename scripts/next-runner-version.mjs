#!/usr/bin/env node
/**
 * The version the next runner release carries. `Cargo.toml`'s `[workspace.package]
 * version` is the LINE; the patch is the release counter read off the `runner-v*`
 * tags, because `main` is protected and no CI push of a version-bump commit can
 * reach it. A version at or below one published is refused: no box would apply it.
 *
 * `--channel dev` numbers the dev line (ISS-1358): the newest `main` release on the
 * line, or the declared patch where there is none, then `-dev.<n>` counted per base.
 * A dev version always carries that suffix and a `main` one never does, so the two
 * lines cannot cut the same tag, and `main`'s count reads past every dev tag.
 *
 * A commit is released on its line only where a GitHub Release is PUBLISHED for a tag at it
 * (ISS-1373). The tag is cut before the build, so a build that failed or was skipped leaves a
 * tag with no release: the next run for that commit reuses that tag rather than computing a new
 * version. The published tags are read by the workflow, which has the token; this script reads
 * them from a file and never calls the network.
 * --sha <commit> --published <file> [--channel main|dev]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CARGO_PATH = 'packages/runner/Cargo.toml';
const TAG_PREFIX = 'runner-v';
const CHANNELS = ['main', 'dev'];
const DEV_TAG = /^(\d+)\.(\d+)\.(\d+)-dev\.(\d+)$/;

/** The line a runner tag is on: `dev` for `-dev.<n>` (ISS-1358), `main` for any other. */
export function lineOf(tag) {
  return /-dev\.\d+$/.test(tag) ? 'dev' : 'main';
}

/**
 * The `runner-v*` tags at one commit on `channel`'s line, split by whether a GitHub Release is
 * published for each. Only `released` makes the commit released; an `unpublished` tag is one
 * whose build never published, and the commit's release is still owed under it.
 *
 * @param {string[]} atCommit the tags pointing at the commit
 * @param {Iterable<string>} published the tags carrying a published (non-draft) GitHub Release
 * @param {'main' | 'dev'} channel
 */
export function tagsAtCommit(atCommit, published, channel) {
  const isPublished = new Set(published);
  const onLine = atCommit.filter((t) => t.startsWith(TAG_PREFIX) && lineOf(t) === channel);
  return {
    released: onLine.filter((t) => isPublished.has(t)),
    unpublished: onLine.filter((t) => !isPublished.has(t)),
  };
}

/** The tag names in a published-releases file, one per line. */
export function readPublished(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `[major, minor, patch, n]` for a tag of `channel`'s shape, or null. */
function lineKey(tag, channel) {
  const v = tag.slice(TAG_PREFIX.length);
  if (channel === 'dev') {
    const m = DEV_TAG.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
  }
  const t = triple(v);
  return t ? [...t, 0] : null;
}

/** The highest unpublished tag of `channel`'s shape at the commit, where none there is released. */
function owedTag(standing, channel) {
  const { released, unpublished } = tagsAtCommit(standing.atCommit, standing.published, channel);
  if (released.length > 0) return null;
  const keyed = unpublished
    .map((tag) => ({ tag, key: lineKey(tag, channel) }))
    .filter(({ key }) => key !== null)
    .sort(
      (a, b) =>
        a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2] || a.key[3] - b.key[3],
    );
  return keyed.at(-1)?.tag ?? null;
}

/** The `[workspace.package] version` in a Cargo manifest, or null. */
export function workspaceVersion(cargoToml) {
  const section = cargoToml.split(/^\[/m).find((s) => s.startsWith('workspace.package]'));
  const m = section?.match(/^\s*version\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

function triple(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** The `runner-v<x.y.z>` tags in `tags`, as triples. Anything else is ignored. */
export function releasedVersions(tags) {
  return tags
    .map((t) => (t.startsWith(TAG_PREFIX) ? triple(t.slice(TAG_PREFIX.length)) : null))
    .filter((t) => t !== null);
}

/** The dev tags in `tags` as `{ base: [x, y, z], n }`. */
function devReleases(tags) {
  return tags
    .map((t) => (t.startsWith(TAG_PREFIX) ? DEV_TAG.exec(t.slice(TAG_PREFIX.length)) : null))
    .filter((m) => m !== null)
    .map((m) => ({ base: [Number(m[1]), Number(m[2]), Number(m[3])], n: Number(m[4]) }));
}

/**
 * The next version, or a thrown refusal naming what has to change.
 *
 * @param {string} cargoToml raw `packages/runner/Cargo.toml`
 * @param {string[]} tags every tag in the repository
 * @param {'main' | 'dev'} channel the line being cut
 * @param {{ atCommit: string[], published: Iterable<string> }} [standing] the tags at the commit
 *   being released, and the tags with a published release; absent, no tag is reused
 */
export function nextRunnerVersion(cargoToml, tags, channel = 'main', standing = undefined) {
  const declared = workspaceVersion(cargoToml);
  if (declared === null) {
    throw new Error(`${CARGO_PATH} declares no [workspace.package] version — nothing to release`);
  }
  const line = triple(declared);
  if (line === null) {
    throw new Error(
      `${CARGO_PATH} declares version "${declared}", which is not <major>.<minor>.<patch> — nothing to release`,
    );
  }
  const [major, minor, patch] = line;
  const released = releasedVersions(tags);

  const ahead = released.filter(([ma, mi]) => ma > major || (ma === major && mi > minor));
  if (ahead.length > 0) {
    const highest = ahead.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).at(-1);
    throw new Error(
      `${CARGO_PATH} declares ${declared}, but runner-v${highest.join('.')} is already released — ` +
        `a release cut from this line would be below it and no box would apply it. ` +
        `Raise the version in ${CARGO_PATH} above ${highest[0]}.${highest[1]}.`,
    );
  }

  const owed = standing === undefined ? null : owedTag(standing, channel);
  if (owed !== null) {
    const version = owed.slice(TAG_PREFIX.length);
    return { version, tag: owed, prerelease: channel === 'dev', reused: true };
  }

  const onLine = released.filter(([ma, mi]) => ma === major && mi === minor);
  if (channel === 'dev') {
    const base = onLine.length === 0 ? patch : Math.max(...onLine.map(([, , p]) => p));
    const counted = devReleases(tags)
      .filter(({ base: [x, y, z] }) => x === major && y === minor && z === base)
      .map(({ n }) => n);
    const n = counted.length === 0 ? 1 : Math.max(...counted) + 1;
    const version = `${major}.${minor}.${base}-dev.${n}`;
    return { version, tag: `${TAG_PREFIX}${version}`, prerelease: true, reused: false };
  }
  const next = onLine.length === 0 ? patch : Math.max(...onLine.map(([, , p]) => p)) + 1;
  const version = `${major}.${minor}.${next}`;
  return { version, tag: `${TAG_PREFIX}${version}`, prerelease: false, reused: false };
}

/** The `--channel` argument: `main` where absent, refused by name where it is neither line. */
export function parseChannel(args) {
  const i = args.indexOf('--channel');
  if (i === -1) return 'main';
  const value = args[i + 1] ?? '';
  if (!CHANNELS.includes(value)) {
    throw new Error(`--channel "${value}" is not a runner release channel; it takes main or dev`);
  }
  return value;
}

/**
 * `--sha` and `--published`, both required: without them a tag whose build never published reads
 * as a release, or a published one as owed, and either is the wrong release.
 */
export function parseStanding(args) {
  const value = (name) => {
    const i = args.indexOf(`--${name}`);
    const v = i === -1 ? undefined : args[i + 1];
    return v === undefined || v.startsWith('--') ? null : v;
  };
  const sha = value('sha');
  if (sha === null) {
    throw new Error('--sha <commit> is required: the commit this release is cut from');
  }
  const publishedFile = value('published');
  if (publishedFile === null) {
    throw new Error(
      '--published <file> is required: the runner-v* tags with a published GitHub Release, one per ' +
        'line, without which a tag whose build never published cannot be told from a release',
    );
  }
  return { sha, publishedFile };
}

const listTags = (args) =>
  execFileSync('git', ['tag', ...args, '--list', `${TAG_PREFIX}*`], { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

function main() {
  const args = process.argv.slice(2);
  const channel = parseChannel(args);
  const { sha, publishedFile } = parseStanding(args);
  const cargoToml = readFileSync(CARGO_PATH, 'utf8');
  const standing = {
    atCommit: listTags(['--points-at', sha]),
    published: readPublished(publishedFile),
  };
  const { version, tag, prerelease, reused } = nextRunnerVersion(
    cargoToml,
    listTags([]),
    channel,
    standing,
  );
  process.stdout.write(
    `version=${version}\ntag=${tag}\nprerelease=${prerelease}\nreused=${reused}\n`,
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`next-runner-version: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
}
