#!/usr/bin/env node
// A test whose input is the whole repository declares it in its own text, and this runs exactly
// those on every change. CI's `changes` filter selects a job by the paths a pull request touched,
// so a guard that walks the tree but lives under `packages/core` was skipped by a documents-only
// change that broke it, and `ci-passed` read the skip as a pass (ISS-1314).
//
//   node scripts/check-whole-tree-gates.mjs         the declarations: which files, and every refusal
//   node scripts/check-whole-tree-gates.mjs --run   and then run each declared file where it is collected
//
// Exit 0 clean · 1 a refusal or a failing gate · 2 could not run, or nothing declared at all.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CONFIG_RE } from './lib/test-reachability.mjs';
import {
  declarationExit,
  judgeDeclarations,
  judgeRun,
  SOURCE_FILE_RE,
} from './lib/whole-tree-gates.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUN = process.argv.includes('--run');

function die(msg) {
  console.error(`whole-tree-gates: ${msg}`);
  process.exit(2);
}

const ls = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
if (ls.status !== 0) die('could not list tracked files — not a git repository?');
const tracked = ls.stdout.split('\n').filter(Boolean);

const files = [];
for (const path of tracked.filter((f) => SOURCE_FILE_RE.test(f))) {
  try {
    files.push({ path, source: readFileSync(join(ROOT, path), 'utf8') });
  } catch {
    die(`${path} is tracked but not on disk — stage the deletion or restore the file`);
  }
}

const { tests, declared, refused } = judgeDeclarations({ files });

function report(list) {
  for (const { path, why } of list) console.error(`  ${path}\n    ${why}`);
}

const exit = declarationExit({ declared, refused });
if (exit === 1) {
  console.error(`whole-tree-gates: ${refused.length} file(s) refused:\n`);
  report(refused);
  console.error(
    '\nA test whose input is the repository is selected by nothing but its declaration, so one',
  );
  console.error('it does not carry runs only when its own directory happens to change.');
  process.exit(1);
}

if (exit === 2) {
  die(
    `none of ${tests} test file(s) declares \`@gate-input whole-tree\` — an empty scope, not a pass. ` +
      'A declaration that was renamed or dropped reads exactly like this.',
  );
}

console.log(
  `whole-tree-gates: ${tests} test file(s) read, ${declared.length} declared whole-tree: ${declared.join(', ')}`,
);
if (!RUN) process.exit(0);

const configs = tracked.filter((f) => CONFIG_RE.test(f));
if (configs.length === 0) die('found no vitest config — nothing could run a declared file');
const absolute = declared.map((f) => join(ROOT, f));

function vitest(config, args) {
  return spawnSync(
    'pnpm',
    ['exec', 'vitest', ...args, '--config', config.split('/').pop(), ...absolute],
    { cwd: resolve(ROOT, dirname(config)), encoding: 'utf8', timeout: 600_000 },
  );
}

const collected = {};
for (const config of configs) {
  const r = vitest(config, ['list', '--filesOnly']);
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (r.status !== 0 && !/No test files found/.test(out)) {
    die(`\`vitest list\` failed for ${config}:\n${r.stderr ?? ''}`);
  }
  const cwd = resolve(ROOT, dirname(config));
  const found = (r.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => relative(ROOT, resolve(cwd, l)))
    .filter((f) => declared.includes(f));
  if (found.length > 0) collected[config] = found;
}

const executed = Object.fromEntries(declared.map((f) => [f, 0]));
let failed = false;
const scratch = mkdtempSync(join(tmpdir(), 'whole-tree-gates-'));
try {
  for (const [config, list] of Object.entries(collected)) {
    const out = join(scratch, `${config.replaceAll('/', '_')}.json`);
    console.log(`\nwhole-tree-gates: ${config} — ${list.join(', ')}`);
    const r = spawnSync(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--config',
        config.split('/').pop(),
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${out}`,
        ...list.map((f) => join(ROOT, f)),
      ],
      { cwd: resolve(ROOT, dirname(config)), stdio: ['ignore', 'inherit', 'inherit'] },
    );
    if (r.status !== 0) failed = true;
    let doc;
    try {
      doc = JSON.parse(readFileSync(out, 'utf8'));
    } catch {
      die(`vitest wrote no JSON report for ${config}, so what ran cannot be read`);
    }
    for (const file of doc.testResults ?? []) {
      const rel = relative(ROOT, file.name);
      const ran = (file.assertionResults ?? []).filter(
        (a) => a.status === 'passed' || a.status === 'failed',
      ).length;
      if (rel in executed) executed[rel] += ran;
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const run = judgeRun({ declared, collected, executed });
if (run.refused.length > 0) {
  console.error(`\nwhole-tree-gates: ${run.refused.length} declared file(s) proved nothing:\n`);
  report(run.refused);
  process.exit(1);
}
if (failed) {
  console.error('\nwhole-tree-gates: a declared whole-tree gate failed — read its output above');
  process.exit(1);
}
const cases = Object.values(executed).reduce((a, b) => a + b, 0);
console.log(
  `\nwhole-tree-gates: ${declared.length} declared file(s) ran ${cases} case(s) under ${Object.keys(collected).length} config(s), all green`,
);
