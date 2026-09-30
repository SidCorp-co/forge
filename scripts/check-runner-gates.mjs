#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseRef } from './lib/base-branch.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
  { label: 'test', argv: ['cargo', 'test', '--workspace'] },
];

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

/** Why the scope could not be computed, set beside the `no-base` sentinel below. */
let noBase = null;

function changedCrateFiles() {
  if (git(['rev-parse', '--git-dir']) === null) return 'no-git';
  const target = baseRef(ROOT);
  if (target.refusal) {
    noBase = target.refusal;
    return 'no-base';
  }
  const base = git(['merge-base', target.ref, 'HEAD'])?.trim();
  if (!base) {
    noBase =
      `\`git merge-base ${target.ref} HEAD\` did not answer, so the changed set cannot be scoped —\n` +
      `run \`git fetch origin ${target.branch}\`, or pass --all to run every gate unconditionally.`;
    return 'no-base';
  }
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
  : (git(['ls-files', '--', 'packages/runner']) ?? '').split('\n').filter(Boolean).length;

const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
if (cargo.error || cargo.status !== 0) {
  console.error(
    `runner-gates: ${count} crate file(s) changed and cargo is not on PATH, so this box measured none of them.`,
  );
  console.error(
    'Install Rust (https://rustup.rs) or put cargo on PATH, then run `pnpm verify` again.',
  );
  console.error(
    'CI runs the same four gates on three platforms — but not before you push, which is the whole',
  );
  console.error('reason this check exists: 0.7.6 was verified 13/13 and took the release down.');
  process.exit(2);
}
console.log(`runner-gates: ${count} crate file(s) in scope`);

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
    console.error(`runner-gates: cargo ${gate.label} failed — this is the ci.yml \`runner\` job`);
    process.exit(1);
  }
}

console.log(`runner-gates: ${count} crate file(s) passed the ci.yml \`runner\` gates`);
