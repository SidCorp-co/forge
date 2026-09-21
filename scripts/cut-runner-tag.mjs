#!/usr/bin/env node
/**
 * Create a `runner-v*` tag and push it, WITHOUT forcing: a tag that already exists
 * fails the run, because a moved release tag leaves two binaries claiming one
 * version. <tag> <commit> [--remote <name>] [--cwd <dir>]
 */
import { execFileSync } from 'node:child_process';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The commit a tag points at, or null when the tag does not exist. */
export function tagTarget(cwd, tag) {
  try {
    return git(cwd, ['rev-list', '-n', '1', `refs/tags/${tag}`]).trim();
  } catch {
    return null;
  }
}

/** The `runner-v*` tags pointing at `commit`, if any. */
export function releasesAt(cwd, commit) {
  try {
    return git(cwd, ['tag', '--points-at', commit, '--list', 'runner-v*'])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Create `tag` at `commit`. Refuses an existing tag, or an already-released commit. */
export function cutRunnerTag({ cwd, tag, commit, remote = 'origin' }) {
  // A rerun of an older run allocates a HIGHER version from today's tags and would
  // publish yesterday's code under it: numerically forward, functionally back.
  const already = releasesAt(cwd, commit);
  if (already.length > 0) {
    throw new Error(
      `${commit} is already released as ${already.join(', ')} — nothing to release, and ` +
        `cutting ${tag} here would publish that code under a higher version than what ` +
        `followed it. Nothing was pushed.`,
    );
  }
  const existing = tagTarget(cwd, tag);
  if (existing !== null) {
    throw new Error(
      `${tag} already exists at ${existing} — a release tag is never moved. ` +
        `Nothing was pushed. If this release has to be recut, delete the tag and its ` +
        `GitHub Release first, and read /api/install/latest.json back afterwards.`,
    );
  }
  git(cwd, ['tag', tag, commit]);
  try {
    git(cwd, ['push', remote, `refs/tags/${tag}`]);
  } catch (err) {
    // Somebody else cut it between the read above and this push. Take the local tag
    // back off so a rerun sees the world rather than a half-made release.
    git(cwd, ['tag', '-d', tag]);
    throw new Error(
      `pushing ${tag} to ${remote} was refused, so no release was cut: ` +
        `${err instanceof Error ? err.message.trim() : String(err)}`,
    );
  }
  return { tag, commit };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };
  const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  const [tag, commit] = positional;
  if (!tag || !commit) {
    throw new Error('usage: cut-runner-tag.mjs <tag> <commit> [--remote <name>] [--cwd <dir>]');
  }
  cutRunnerTag({ cwd: opt('cwd', process.cwd()), tag, commit, remote: opt('remote', 'origin') });
  process.stdout.write(`cut ${tag} at ${commit}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`cut-runner-tag: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
}
