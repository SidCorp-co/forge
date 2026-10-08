#!/usr/bin/env node
/**
 * The commit on `main` a runner change is released as: the first one on the ref's first-parent
 * line that has the newest runner-touching commit in its history. That is the merge for a pull
 * request merged with one, never its head, so a build contains the merge that landed it.
 * [--ref <ref>] [--cwd <dir>]
 */
import { execFileSync } from 'node:child_process';

const RUNNER_PATH = 'packages/runner';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function isAncestor(cwd, ancestor, descendant) {
  try {
    git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (err) {
    // Exit 1 is git's "no"; anything else is a fault.
    if (err && typeof err === 'object' && err.status === 1) return false;
    throw err;
  }
}

/** Refuses by name where `ref`'s history holds no commit under the runner package. */
export function runnerReleaseCommit({ cwd, ref = 'HEAD', path = RUNNER_PATH }) {
  const touched = git(cwd, ['log', '-1', '--format=%H', ref, '--', path]).trim();
  if (touched === '') {
    throw new Error(
      `no commit under ${path} is reachable from ${ref}, so there is no runner change to release`,
    );
  }
  // Newest first: those holding `touched` form a suffix, so the walk stops at the first that doesn't.
  const line = git(cwd, ['rev-list', '--first-parent', ref]).split('\n').filter(Boolean);
  let chosen = null;
  for (const sha of line) {
    if (!isAncestor(cwd, touched, sha)) break;
    chosen = sha;
  }
  if (chosen === null) {
    throw new Error(`${touched} touches ${path} but is not an ancestor of ${ref}, which cannot be`);
  }
  return chosen;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };
  process.stdout.write(
    `${runnerReleaseCommit({ cwd: opt('cwd', process.cwd()), ref: opt('ref', 'HEAD') })}\n`,
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`runner-release-commit: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
}
