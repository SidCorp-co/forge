#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { baseRef } from './lib/base-branch.mjs';
import { gitOut, ROOT } from './lib/gate.mjs';

const CRATE_DIR = resolve(ROOT, 'packages/runner');
const all = process.argv.includes('--all');

const GATES = [
  {
    label: 'metadata --locked',
    argv: ['cargo', 'metadata', '--locked', '--format-version=1'],
    discardStdout: true,
  },
  { label: 'fmt --check', argv: ['cargo', 'fmt', '--check'] },
  {
    label: 'clippy -D warnings',
    argv: ['cargo', 'clippy', '--workspace', '--all-targets', '--', '-D', 'warnings'],
  },
];
// No `cargo test --workspace` here: that is the runner's whole suite, and verify is the merge gate,
// which runs only the direct tests of what a change touched (REQ-36 BC-17, ISS-472). Those are
// `scripts/lib/direct-test-run.mjs`'s; the whole suite runs nightly and on a release cut's commit.

/** Why the scope could not be computed, set beside the `no-base` sentinel below. */
let noBase = null;

function changedCrateFiles() {
  if (gitOut(['rev-parse', '--git-dir']) === null) return 'no-git';
  const target = baseRef(ROOT);
  if (target.refusal) {
    noBase = target.refusal;
    return 'no-base';
  }
  const base = gitOut(['merge-base', target.ref, 'HEAD'])?.trim();
  if (!base) {
    noBase =
      `\`git merge-base ${target.ref} HEAD\` did not answer, so the changed set cannot be scoped —\n` +
      `run \`git fetch origin ${target.branch}\`, or pass --all to run every gate unconditionally.`;
    return 'no-base';
  }
  const files = new Set();
  const diffed = gitOut(['diff', '--name-only', base, '--', 'packages/runner']) ?? '';
  for (const l of diffed.split('\n')) {
    if (l.trim()) files.add(l.trim());
  }
  for (const l of (gitOut(['status', '--porcelain', '--', 'packages/runner']) ?? '').split('\n')) {
    const p = l.slice(3).trim();
    if (p) files.add(p);
  }
  return files;
}

const changed = all ? null : changedCrateFiles();
if (changed === 'no-git') {
  console.log('runner-gates: skipped — no git repository, so the changed set is unknowable');
  process.exit(0);
}
if (changed === 'no-base') {
  console.error(`runner-gates: ${noBase}`);
  process.exit(2);
}
if (changed !== null && changed.size === 0) {
  console.log('runner-gates: 0 crate file(s) in scope — nothing to check');
  process.exit(0);
}

const count = changed
  ? changed.size
  : (gitOut(['ls-files', '--', 'packages/runner']) ?? '').split('\n').filter(Boolean).length;

const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
if (cargo.error || cargo.status !== 0) {
  console.error(
    `runner-gates: ${count} crate file(s) changed and cargo is not on PATH, so this box measured none of them.`,
  );
  console.error(
    'Install Rust (https://rustup.rs) or put cargo on PATH, then run `pnpm verify` again.',
  );
  console.error(
    'CI runs these gates on three platforms — but not before you push, which is the whole',
  );
  console.error('reason this check exists: 0.7.6 was verified 13/13 and took the release down.');
  process.exit(2);
}
console.log(`runner-gates: ${count} crate file(s) in scope`);

// ADR 0009's size rule: no file's production section (everything above its first
// `#[cfg(test)]`) passes FILE_LIMIT lines. Functions are held to 100 by clippy.toml.
const FILE_LIMIT = 800;
const oversize = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'target') walk(p);
    } else if (e.name.endsWith('.rs')) {
      const lines = readFileSync(p, 'utf8').split('\n');
      const cut = lines.findIndex((l) => l.startsWith('#[cfg(test)]'));
      const n = cut === -1 ? lines.length - (lines.at(-1) === '' ? 1 : 0) : cut;
      if (n > FILE_LIMIT) oversize.push(`${relative(ROOT, p)}: ${n} lines`);
    }
  }
})(resolve(CRATE_DIR, 'crates'));
if (oversize.length) {
  console.error(oversize.join('\n'));
  console.error(
    `runner-gates: ${oversize.length} file(s) hold more than ${FILE_LIMIT} production lines — split by responsibility`,
  );
  process.exit(1);
}

for (const gate of GATES) {
  const r = spawnSync(gate.argv[0], gate.argv.slice(1), {
    cwd: CRATE_DIR,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: gate.discardStdout ? ['ignore', 'ignore', 'pipe'] : undefined,
  });
  if (r.error) {
    console.error(`runner-gates: could not run cargo ${gate.label}: ${r.error.message}`);
    process.exit(2);
  }
  if (r.status !== 0) {
    console.error(`${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-8000));
    console.error(
      `runner-gates: cargo ${gate.label} failed — the ci.yml \`runner\` job runs it too`,
    );
    process.exit(1);
  }
}

console.log(
  `runner-gates: ${count} crate file(s) passed metadata, fmt, clippy and the file-size limit`,
);
