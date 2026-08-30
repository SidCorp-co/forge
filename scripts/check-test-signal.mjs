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
// when it gets worse or a new one appears. The ratchet around that is
// lib/debt-ratchet.mjs; what stays here is the analyzer.
//
// Modes: --all (CI) · --staged (pre-commit) · --update-baseline
// Exit: 0 clean, 1 violations, 2 invalid invocation.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  freezeFaults,
  loadBaseline,
  parseMode,
  sortDeep,
  stagedFiles,
  tunedConfig,
  writeBaseline,
} from './lib/debt-ratchet.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, '.forge', 'test-signal-baseline.json');

// cm:why `.onDelete` is deliberately absent from declarationPattern — cascade-vs-restrict decides whether deleting a parent destroys child rows, which the declaration does not make obvious and a bug here loses data
const DEFAULTS = {
  scanRoots: [
    'packages/core/src',
    'packages/core/tests',
    'packages/web-v2/src',
    'packages/web-v2/tests',
    'packages/contracts/src',
    'packages/contracts/tests',
  ],
  testFileSuffixes: ['.test.ts', '.test.tsx'],
  minAssertions: 20,
  declarationRatio: 0.5,
  mockRatio: 0.7,
  declarationPattern:
    '\\.(columnType|notNull|hasDefault|primary|isUnique|dataType|foreignKeys|indexes)\\b|withTimezone\\(|names\\.sort\\(\\)',
  mockPattern: 'toHaveBeenCalled[A-Za-z]*\\(',
  assertPattern: 'expect\\(',
};

const tuned = tunedConfig(ROOT, 'test-signal', DEFAULTS);
if (tuned.error) {
  console.error(`check-test-signal: ${tuned.error}`);
  process.exit(2);
}
const CFG = tuned.config;
const DECLARATION_RE = new RegExp(CFG.declarationPattern, 'g');
const MOCK_RE = new RegExp(CFG.mockPattern, 'g');
const ASSERT_RE = new RegExp(CFG.assertPattern, 'g');

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
  if (score.assertions < CFG.minAssertions) return [];
  const reasons = [];
  const decl = score.declaration / score.assertions;
  const mock = score.mock / score.assertions;
  if (decl >= CFG.declarationRatio) {
    reasons.push(
      `${Math.round(decl * 100)}% of assertions restate a declaration ` +
        `(${score.declaration}/${score.assertions}) — these fail on intended change, never on a bug`,
    );
  }
  if (mock >= CFG.mockRatio) {
    reasons.push(
      `${Math.round(mock * 100)}% of assertions only check that a mock was called ` +
        `(${score.mock}/${score.assertions}) — asserts wiring, not behaviour`,
    );
  }
  return reasons;
}

function isTestFile(path) {
  return CFG.testFileSuffixes.some((s) => path.endsWith(s));
}

function walk(dir, out) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (isTestFile(full)) out.push(full);
  }
  return out;
}

function collectAll() {
  const files = [];
  for (const root of CFG.scanRoots) walk(join(ROOT, root), files);
  return files;
}

function collectStaged() {
  const staged = stagedFiles(ROOT);
  if (staged.error) {
    console.error(`check-test-signal: ${staged.error}`);
    process.exit(2);
  }
  return [...staged.files]
    .filter(isTestFile)
    .map((f) => join(ROOT, f))
    .filter((f) => existsSync(f));
}

const parsed = parseMode(
  process.argv,
  ['--all', '--staged', '--update-baseline'],
  'check-test-signal.mjs',
);
if (parsed.error) {
  console.error(parsed.error);
  process.exit(2);
}
const mode = parsed.mode;

const files = mode === '--staged' ? collectStaged() : collectAll();
// cm:guard `--all` finding zero test files means scanRoots point nowhere, not that the repo has no tests. Reporting clean there is the fail-open shape every checker in this repo exits 2 on; `--staged` may legitimately be empty.
if (mode !== '--staged' && files.length === 0) {
  console.error(
    `check-test-signal: no test files under ${CFG.scanRoots.join(', ')} — check ` +
      'checkers.test-signal.scanRoots in .forge/conformance.json',
  );
  process.exit(2);
}

// cm:guard an unreadable baseline REFUSES, and does not fall through to an empty one. Read as `{}` this checker still exits 1 — every frozen file reads as new — but --update-baseline overwrites the damaged file without ever having read it, which turns a corrupt baseline into a silently re-frozen one. Same refusal as check-lint-budget.mjs, which the shared module exists to keep in step.
const doc = loadBaseline(BASELINE_PATH);
if (doc === null) {
  console.error(
    `check-test-signal: ${BASELINE_PATH} is unreadable — fix or delete it. This will not\n` +
      'guess what was frozen, and --update-baseline will not overwrite what it could not read.',
  );
  process.exit(2);
}
const baseline = doc.files ?? {};

// cm:guard a file is RECORDED only when a ratio trips, which is what separates this checker from the biome budgets: they freeze every diagnostic, this freezes only files already over the line. So the baseline holds offenders, not measurements, and a file that drops below the ratio leaves the baseline entirely rather than being frozen at a lower number.
const current = {};
for (const file of files) {
  const rel = relative(ROOT, file);
  const score = scoreFile(readFileSync(file, 'utf8'));
  if (violationsFor(score).length === 0) continue;
  current[rel] = { declaration: score.declaration, mock: score.mock };
}

if (mode === '--update-baseline') {
  writeBaseline(BASELINE_PATH, {
    generatedAt: new Date().toISOString(),
    files: sortDeep(current),
  });
  console.log(`test-signal baseline written: ${Object.keys(current).length} file(s) frozen`);
  process.exit(0);
}

const failures = freezeFaults(current, baseline);

if (failures.length === 0) {
  console.log(`test-signal: ${files.length} test file(s) checked, no new low-signal tests`);
  process.exit(0);
}

for (const { file } of failures) {
  console.error(`\n${file}`);
  const score = scoreFile(readFileSync(join(ROOT, file), 'utf8'));
  for (const r of violationsFor(score)) console.error(`  ${r}`);
  const was = baseline[file];
  if (was) {
    console.error(
      `  baseline allowed declaration=${was.declaration} mock=${was.mock}; ` +
        `now declaration=${score.declaration} mock=${score.mock} — it got worse`,
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
