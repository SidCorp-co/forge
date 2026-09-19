#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseRev } from './lib/baseline-ratchet.mjs';
import { selectionFor } from './lib/changed-selection.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TREE_COUPLED =
  /from ['"]node:fs['"]|readFileSync|readdirSync|globSync|execFileSync|spawnSync/;

const FULL_RUN_SHARE = 0.5;

const PACKAGES = [
  { name: '@forge/core', dir: 'packages/core', testGlob: /\.test\.ts$/ },
  { name: 'web-v2', dir: 'packages/web-v2', testGlob: /\.test\.tsx?$/ },
];

function die(msg) {
  console.error(`test-changed: ${msg}`);
  process.exit(2);
}

function vitest(pkgDir, args, capture) {
  return spawnSync('npx', ['vitest', ...args], {
    cwd: join(ROOT, pkgDir),
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
}

/** Test files vitest would collect for `args`, as package-relative paths. */
function listFiles(pkg, args) {
  const r = vitest(pkg.dir, ['list', '--filesOnly', ...args], true);
  if (r.error) die(`could not run vitest in ${pkg.dir}: ${r.error.message}`);
  if (r.status !== 0) die(`vitest list failed in ${pkg.dir}:\n${r.stderr ?? ''}`);
  return (r.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => pkg.testGlob.test(l))
    .map((l) => (l.startsWith('/') ? relative(join(ROOT, pkg.dir), l) : l));
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, e.name);
    if (e.isDirectory()) walk(child, out);
    else if (e.isFile()) out.push(child);
  }
  return out;
}

/** Test files whose subject is the tree itself, so no import edge reaches them. */
function alwaysLane(pkg) {
  const files = [];
  for (const abs of walk(join(ROOT, pkg.dir, 'src'))) {
    if (!pkg.testGlob.test(abs)) continue;
    if (TREE_COUPLED.test(readFileSync(abs, 'utf8'))) {
      files.push(relative(join(ROOT, pkg.dir), abs));
    }
  }
  return files.sort();
}

const base = baseRev(ROOT);
if (!base) die('no base revision — a shallow or single-commit checkout cannot say what changed');

console.log(`test-changed: selecting against ${base.slice(0, 8)}`);

let worst = 0;

for (const pkg of PACKAGES) {
  const all = listFiles(pkg, []);
  const always = alwaysLane(pkg);
  const selected = listFiles(pkg, ['--changed', base]);
  const { skip, full, files, union } = selectionFor({
    all,
    selected,
    always,
    fullRunShare: FULL_RUN_SHARE,
  });
  if (skip) {
    console.log(`  ${pkg.name}: no test reached by this change and none reads the tree — skipped`);
    continue;
  }
  console.log(
    full
      ? `  ${pkg.name}: ${union.length}/${all.length} files selected — over ${FULL_RUN_SHARE * 100}%, running the whole suite instead`
      : `  ${pkg.name}: ${selected.length} reached + ${always.length} tree-coupled = ${union.length}/${all.length} files`,
  );

  const r = vitest(pkg.dir, ['run', ...files], false);
  if (r.error) die(`could not run vitest in ${pkg.dir}: ${r.error.message}`);
  worst = Math.max(worst, r.status ?? 1);
}

console.log(
  '\ntest-changed: a SELECTED run — this is not a green.\n' +
    '  The graph follows imports. A test that reaches its subject any other way — a route by\n' +
    '  URL, a table by name, a file by path — is only here if it scans the tree.\n' +
    '  Before you push: pnpm test && pnpm --filter @forge/core test:integration',
);

process.exit(worst === 0 ? 0 : 1);
