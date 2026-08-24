#!/usr/bin/env node
// The Rust runner's own gates, run locally so `pnpm verify` cannot be green while
// the `runner` job in ci.yml is red.
//
// That gap was real and it cost a release: 0.7.6 was written, verified 13/13,
// pushed and tagged — and `cargo fmt --check` failed on the new file, which took
// down runner-ci AND runner-release, so no GitHub Release was cut and the install
// channel had nothing to serve. `CI_COVERAGE` had declared the step honestly as
// "cargo, runner-only" the whole time; declaring a hole does not close it.
//
// Runs the SAME four commands as ci.yml's `runner` job, in the same order. Adds no
// rule of its own — notably no `-D warnings`, because that job does not have it and
// a local gate stricter than CI teaches contributors to ignore it.
//
// Scoped to a diff like the CI job is (`packages/runner/**` paths filter), so
// core-only work never pays for a Rust build. Skips with an explicit line when
// cargo is absent, because a contributor with no Rust toolchain must still be able
// to run `pnpm verify` on a TypeScript change.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_DIR = resolve(ROOT, 'packages/runner');
const all = process.argv.includes('--all');

// cm:edge lockstep -> .github/workflows/ci.yml — the `runner` job's step runs exactly these four, in this order, and `--ci-parity` maps that step to this script. Add one there and not here and `pnpm verify` goes back to being green while the merge gate is red.
const GATES = [
  // cm:guard `>/dev/null` in the CI step is not cosmetic — this prints ~1.3MB of JSON, which blows Node's 1MB default `maxBuffer`, so spawnSync KILLS it and reports a failure the gate never had. Discard its stdout here for the same reason.
  {
    label: 'metadata --locked',
    argv: ['cargo', 'metadata', '--locked', '--format-version=1'],
    discardStdout: true,
  },
  { label: 'fmt --check', argv: ['cargo', 'fmt', '--check'] },
  { label: 'clippy', argv: ['cargo', 'clippy', '--workspace', '--all-targets'] },
  { label: 'test', argv: ['cargo', 'test', '--workspace'] },
];

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

/**
 * Crate files this change touches: committed against origin/main plus anything
 * still uncommitted. Both halves matter — the point is to fail before the push,
 * and at that moment the work is usually not committed yet.
 *
 * `'no-git'` when there is no repository to ask, `'no-base'` when there is one but
 * it cannot name a base revision.
 */
// cm:guard an unresolvable base is NOT an empty diff. A shallow or freshly-cloned tree has no origin/main, merge-base fails, and returning an empty Set here made this print `0 crate file(s) in scope` and exit 0 over a change that rewrote the whole crate — the same fail-open that let 15 CM001 errors past the prose gate and ran the baseline ratchet against nothing in CI. Reproduced 2026-08-24 with `git clone --depth 1`.
function changedCrateFiles() {
  if (git(['rev-parse', '--git-dir']) === null) return 'no-git';
  const base = git(['merge-base', 'origin/main', 'HEAD'])?.trim();
  if (!base) return 'no-base';
  const files = new Set();
  for (const l of (git(['diff', '--name-only', base, '--', 'packages/runner']) ?? '').split('\n')) {
    if (l.trim()) files.add(l.trim());
  }
  for (const l of (git(['status', '--porcelain', '--', 'packages/runner']) ?? '').split('\n')) {
    const p = l.slice(3).trim();
    if (p) files.add(p);
  }
  return files;
}

const changed = all ? null : changedCrateFiles();
// cm:why exit 0 for a tarball and exit 2 for a repo with no base — the first cannot be fixed by the person running it and would only get `pnpm verify` abandoned, the second is one `git fetch origin main` away
if (changed === 'no-git') {
  console.log('runner-gates: skipped — no git repository, so the changed set is unknowable');
  process.exit(0);
}
// cm:guard compare against 'no-base', never against null — `--all` sets `changed` to null on purpose, and keying the failure off that made this script refuse to run in the very mode its own error message tells you to use. Caught only because the message was read back.
if (changed === 'no-base') {
  console.error('runner-gates: could not resolve origin/main to scope the diff — run `git fetch origin main`, or pass --all to run every gate unconditionally.');
  process.exit(2);
}
if (changed !== null && changed.size === 0) {
  console.log('runner-gates: 0 crate file(s) in scope — nothing to check');
  process.exit(0);
}

// cm:guard skip LOUDLY and exit 0, never exit 2. Exit 2 means "the gate could not run" and would fail `pnpm verify` for every contributor without a Rust toolchain working on TypeScript — which would get the whole check deleted rather than fixed.
const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
if (cargo.error || cargo.status !== 0) {
  console.log('runner-gates: skipped — cargo not available locally, CI runs it');
  process.exit(0);
}

// cm:guard always print a NUMBER: verify.mjs parses this line and does `Number(m[1])`, so a word like `all` becomes NaN and the run displays a file count nobody can check.
const count = changed
  ? changed.size
  : (git(['ls-files', '--', 'packages/runner']) ?? '').split('\n').filter(Boolean).length;
// cm:guard print the scope BEFORE running the gates, and word it as scope rather than as a verdict. verify.mjs needs this line to prove the scope was computed; printed only on success it is absent exactly when a gate fails, and verify then reports a real violation as exit 2 `could not run` — which is the code this repo reserves for a gate that is not measuring anything.
console.log(`runner-gates: ${count} crate file(s) in scope`);

for (const gate of GATES) {
  const r = spawnSync(gate.argv[0], gate.argv.slice(1), {
    cwd: CRATE_DIR,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: gate.discardStdout ? ['ignore', 'ignore', 'pipe'] : undefined,
  });
  // cm:guard separate "the gate said no" from "the gate could not run", and exit 2 for the second. verify.mjs reads 2 as `could not run` and refuses to call the axis green — reporting a spawn failure as a violation sends the next reader hunting a Rust bug that is not there.
  if (r.error) {
    console.error(`runner-gates: could not run cargo ${gate.label}: ${r.error.message}`);
    process.exit(2);
  }
  if (r.status !== 0) {
    console.error(`${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-8000));
    console.error(`runner-gates: cargo ${gate.label} failed — this is the ci.yml \`runner\` job`);
    process.exit(1);
  }
}

console.log(`runner-gates: ${count} crate file(s) passed the ci.yml \`runner\` gates`);
