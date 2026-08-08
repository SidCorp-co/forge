#!/usr/bin/env node
// Test-signal guard — the test-side counterpart to codemap's comment rule.
//
// codemap stops an agent restating in a comment what the compiler already
// says. This stops the same reflex in tests: asserting what the DECLARATION
// already says. Such a test never fails for a bug, only for an intended
// change — it costs CI time and review attention and returns nothing.
//
// Flags a FILE (not a line) that is mostly either:
//   1. declaration-shape assertions — `.columnType`/`.notNull`/`.hasDefault`/
//      `.primary`/`.isUnique`/`.dataType`. FK `.onDelete` is deliberately NOT
//      flagged: cascade-vs-restrict is a consequence, not a restatement.
//   2. mock-interaction assertions — only that a mock was called.
//
// Baselined like codemap: today's offenders are frozen, a file fails only
// when it gets worse or a new one appears.
//
// Modes: --all (CI) · --staged (pre-commit) · --update-baseline
// Exit: 0 clean, 1 violations, 2 invalid invocation.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, '.forge', 'test-signal-baseline.json');

const MIN_ASSERTIONS = 20;
const DECLARATION_RATIO = 0.5;
const MOCK_RATIO = 0.7;

// cm:why `.onDelete` is deliberately absent — cascade-vs-restrict decides whether deleting a
// parent destroys child rows, which the declaration does not make obvious and a bug here loses data
const DECLARATION_RE =
  /\.(columnType|notNull|hasDefault|primary|isUnique|dataType|foreignKeys|indexes)\b|withTimezone\(|names\.sort\(\)/g;
const MOCK_RE = /toHaveBeenCalled[A-Za-z]*\(/g;
const ASSERT_RE = /expect\(/g;

function countMatches(text, re) {
  return (text.match(re) ?? []).length;
}

/** @returns {{assertions:number, declaration:number, mock:number}} */
export function scoreFile(text) {
  return {
    assertions: countMatches(text, ASSERT_RE),
    declaration: countMatches(text, DECLARATION_RE),
    mock: countMatches(text, MOCK_RE),
  };
}

/** @returns {string[]} reasons this file trips, empty when clean */
export function violationsFor(score) {
  if (score.assertions < MIN_ASSERTIONS) return [];
  const reasons = [];
  const decl = score.declaration / score.assertions;
  const mock = score.mock / score.assertions;
  if (decl >= DECLARATION_RATIO) {
    reasons.push(
      `${Math.round(decl * 100)}% of assertions restate a declaration ` +
        `(${score.declaration}/${score.assertions}) — these fail on intended change, never on a bug`,
    );
  }
  if (mock >= MOCK_RATIO) {
    reasons.push(
      `${Math.round(mock * 100)}% of assertions only check that a mock was called ` +
        `(${score.mock}/${score.assertions}) — asserts wiring, not behaviour`,
    );
  }
  return reasons;
}

function walk(dir, out) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.test.ts') || full.endsWith('.test.tsx')) out.push(full);
  }
  return out;
}

function collectAll() {
  const files = [];
  for (const pkg of ['core', 'web-v2', 'dev', 'contracts']) {
    walk(join(ROOT, 'packages', pkg, 'src'), files);
    walk(join(ROOT, 'packages', pkg, 'tests'), files);
  }
  return files;
}

function collectStaged() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))
    .map((f) => join(ROOT, f))
    .filter((f) => existsSync(f));
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files ?? {};
  } catch {
    return {};
  }
}

const mode = process.argv[2] ?? '--all';
if (!['--all', '--staged', '--update-baseline'].includes(mode)) {
  console.error('usage: check-test-signal.mjs [--all|--staged|--update-baseline]');
  process.exit(2);
}

const files = mode === '--staged' ? collectStaged() : collectAll();
const baseline = loadBaseline();
const current = {};
const failures = [];

for (const file of files) {
  const rel = relative(ROOT, file);
  const score = scoreFile(readFileSync(file, 'utf8'));
  const reasons = violationsFor(score);
  if (reasons.length === 0) continue;

  current[rel] = { declaration: score.declaration, mock: score.mock };

  const was = baseline[rel];
  // cm:guard a baselined file may only IMPROVE — equal counts pass, higher counts fail.
  const worse =
    !was || score.declaration > was.declaration || score.mock > was.mock;
  if (worse) failures.push({ rel, reasons, was, score });
}

if (mode === '--update-baseline') {
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), files: current }, null, 2)}\n`,
  );
  console.log(`test-signal baseline written: ${Object.keys(current).length} file(s) frozen`);
  process.exit(0);
}

if (failures.length === 0) {
  console.log(`test-signal: ${files.length} test file(s) checked, no new low-signal tests`);
  process.exit(0);
}

for (const f of failures) {
  console.error(`\n${f.rel}`);
  for (const r of f.reasons) console.error(`  ${r}`);
  if (f.was) {
    console.error(
      `  baseline allowed declaration=${f.was.declaration} mock=${f.was.mock}; ` +
        `now declaration=${f.score.declaration} mock=${f.score.mock} — it got worse`,
    );
  }
}
console.error(
  `\n${failures.length} file(s) failed the test-signal check.\n` +
    'Assert on BEHAVIOUR (what breaks for a user) instead of on the declaration.\n' +
    'FK cascade/restrict assertions are exempt — they encode a consequence.\n' +
    'If a file is legitimately at this ratio, re-freeze it:\n' +
    '  node scripts/check-test-signal.mjs --update-baseline\n',
);
process.exit(1);
