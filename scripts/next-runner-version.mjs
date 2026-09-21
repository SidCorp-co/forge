#!/usr/bin/env node
/**
 * The version the next runner release carries.
 *
 * `packages/runner/Cargo.toml`'s `[workspace.package] version` is the LINE — the
 * major.minor a release belongs to. The patch is the release counter, read off the
 * `runner-v*` tags that already exist, because `main` carries a required status check
 * and linear history and so no CI push of a version-bump commit can reach it. The
 * released patch is therefore stamped into the binary at build time; see
 * `packages/runner/crates/forge-runner-core/build.rs`.
 *
 * Refusals are loud on purpose. A version that would land at or below one already
 * published is a release no box would ever apply — `update::is_newer` compares the
 * number alone — so it fails naming the file rather than publishing a no-op.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CARGO_PATH = 'packages/runner/Cargo.toml';
const TAG_PREFIX = 'runner-v';

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

/**
 * The next version, or a thrown refusal naming what has to change.
 *
 * @param {string} cargoToml raw `packages/runner/Cargo.toml`
 * @param {string[]} tags every tag in the repository
 */
export function nextRunnerVersion(cargoToml, tags) {
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
  const next =
    onLine.length === 0 ? patch : Math.max(...onLine.map(([, , p]) => p)) + 1;
  const version = `${major}.${minor}.${next}`;
  return { version, tag: `${TAG_PREFIX}${version}` };
}

function main() {
  const cargoToml = readFileSync(CARGO_PATH, 'utf8');
  const tags = execFileSync('git', ['tag', '--list', `${TAG_PREFIX}*`], { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const { version, tag } = nextRunnerVersion(cargoToml, tags);
  process.stdout.write(`version=${version}\ntag=${tag}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`next-runner-version: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
}
