#!/usr/bin/env node
// The local iteration lane: run the tests this change can reach, not all 5,154.
//
// NOT A GATE, and deliberately wired to nothing — no entry in verify's CHECKS, no
// step in ci.yml, no line in CI_COVERAGE. `pnpm test` stays the full run and is
// what CI runs and what you owe before a push. This exists for the loop in
// between, where 112 seconds per edit is the cost being paid.
//
// Two lanes, because vitest's module graph cannot see one of them:
//   selected — tests reached from the changed files (`vitest list --changed`)
//   always   — tests that read the SOURCE TREE rather than importing it
//
// The second lane is the reason this is a script and not a bare vitest flag.
// Measured 2026-09-06: the graph selection for `src/memory/knowledge-promotion.ts`
// is 3 files and misses `issues/one-create-path.test.ts` and `body/doors.test.ts`
// — the exact two gates that file's own commit had to edit. They enforce an
// allowlist by scanning the tree, so nothing imports them into any graph. 14 such
// files in core, 2 in web, 4.5s to run the lot.
//
// Exit: 0 the selected tests passed · 1 a test failed · 2 the selection could not be made.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseRev } from './lib/baseline-ratchet.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// cm:guard the lane is DERIVED by scanning, never a hand-kept list — a list is a second copy of a fact the test files already carry, and the copy is what goes stale. A tree-scanning test added next month joins this lane the first time this runs, with nobody remembering to add it.
const TREE_COUPLED =
  /from ['"]node:fs['"]|readFileSync|readdirSync|globSync|execFileSync|spawnSync/;

// cm:guard past this share of a package's suite the selection has stopped being a saving, so it runs the whole thing and says so — a fast path that quietly becomes the slow one is worse than not having one, and a hub like `db/schema.ts` reaches most of the suite by itself
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
  // cm:guard a non-zero exit is a FAILED answer, never an empty collection — a config that errored and one that matched nothing print the same empty stdout, and reading either as zero would shrink the selection until it passes on a package that runs no tests at all
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
  const union = [...new Set([...selected, ...always])].sort();

  if (selected.length === 0) {
    console.log(`  ${pkg.name}: no test reached by this change — skipped`);
    continue;
  }

  const full = union.length > all.length * FULL_RUN_SHARE;
  const files = full ? [] : union;
  console.log(
    full
      ? `  ${pkg.name}: ${union.length}/${all.length} files selected — over ${FULL_RUN_SHARE * 100}%, running the whole suite instead`
      : `  ${pkg.name}: ${selected.length} reached + ${always.length} tree-coupled = ${union.length}/${all.length} files`,
  );

  const r = vitest(pkg.dir, ['run', ...files], false);
  if (r.error) die(`could not run vitest in ${pkg.dir}: ${r.error.message}`);
  worst = Math.max(worst, r.status ?? 1);
}

// cm:guard this line is the whole safety story — nothing consumes this script's exit code, so the only thing keeping a selected run from being read as a pass is that it says it is not one, every time, including when it is green
console.log(
  '\ntest-changed: a SELECTED run — this is not a green.\n' +
    '  The graph follows imports. A test that reaches its subject any other way — a route by\n' +
    '  URL, a table by name, a file by path — is only here if it scans the tree.\n' +
    '  Before you push: pnpm test && pnpm --filter @forge/core test:integration',
);

process.exit(worst === 0 ? 0 : 1);
