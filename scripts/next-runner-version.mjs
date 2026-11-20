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
 * [--channel main|dev]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CARGO_PATH = 'packages/runner/Cargo.toml';
const TAG_PREFIX = 'runner-v';
const CHANNELS = ['main', 'dev'];
const DEV_TAG = /^(\d+)\.(\d+)\.(\d+)-dev\.(\d+)$/;

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
 */
export function nextRunnerVersion(cargoToml, tags, channel = 'main') {
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

  const onLine = released.filter(([ma, mi]) => ma === major && mi === minor);
  if (channel === 'dev') {
    const base = onLine.length === 0 ? patch : Math.max(...onLine.map(([, , p]) => p));
    const counted = devReleases(tags)
      .filter(({ base: [x, y, z] }) => x === major && y === minor && z === base)
      .map(({ n }) => n);
    const n = counted.length === 0 ? 1 : Math.max(...counted) + 1;
    const version = `${major}.${minor}.${base}-dev.${n}`;
    return { version, tag: `${TAG_PREFIX}${version}`, prerelease: true };
  }
  const next = onLine.length === 0 ? patch : Math.max(...onLine.map(([, , p]) => p)) + 1;
  const version = `${major}.${minor}.${next}`;
  return { version, tag: `${TAG_PREFIX}${version}`, prerelease: false };
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

function main() {
  const cargoToml = readFileSync(CARGO_PATH, 'utf8');
  const tags = execFileSync('git', ['tag', '--list', `${TAG_PREFIX}*`], { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const { version, tag, prerelease } = nextRunnerVersion(
    cargoToml,
    tags,
    parseChannel(process.argv.slice(2)),
  );
  process.stdout.write(`version=${version}\ntag=${tag}\nprerelease=${prerelease}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`next-runner-version: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
}
