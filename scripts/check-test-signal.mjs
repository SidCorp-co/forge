#!/usr/bin/env node
// Test-signal guard: stops a test asserting what the DECLARATION already
// says. Such a test never fails for a bug, only for an intended
// change — it costs CI time and review attention and returns nothing.
//
// Flags a FILE (not a line) that is mostly either:
//   1. declaration-shape assertions — `.columnType`/`.notNull`/`.hasDefault`/
//      `.primary`/`.isUnique`/`.dataType`. FK `.onDelete` is deliberately NOT
//      flagged: cascade-vs-restrict is a consequence, not a restatement.
//   2. mock-interaction assertions — only that a mock was called.
//
// Zero tolerance: no baseline, so a file over a ratio fails. An exemption would be a priced entry in
// .forge/conformance.json, not a frozen count.
//
// Modes: --all (CI) · --staged (pre-commit)
// Exit: 0 clean, 1 violations, 2 invalid invocation.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseMode, stagedFiles, tunedConfig } from './lib/checker-config.mjs';
import { ROOT } from './lib/gate.mjs';

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

const parsed = parseMode(process.argv, ['--all', '--staged'], 'check-test-signal.mjs');
if (parsed.error) {
  console.error(parsed.error);
  process.exit(2);
}
const mode = parsed.mode;

const files = mode === '--staged' ? collectStaged() : collectAll();
if (mode !== '--staged' && files.length === 0) {
  console.error(
    `check-test-signal: no test files under ${CFG.scanRoots.join(', ')} — check ` +
      'checkers.test-signal.scanRoots in .forge/conformance.json',
  );
  process.exit(2);
}

const failures = [];
for (const file of files) {
  if (violationsFor(scoreFile(readFileSync(file, 'utf8'))).length > 0) {
    failures.push({ file: relative(ROOT, file) });
  }
}

if (failures.length === 0) {
  console.log(`test-signal: ${files.length} test file(s) checked, no low-signal tests`);
  process.exit(0);
}

for (const { file } of failures) {
  console.error(`\n${file}`);
  const score = scoreFile(readFileSync(join(ROOT, file), 'utf8'));
  for (const r of violationsFor(score)) console.error(`  ${r}`);
}
console.error(
  `\n${failures.length} file(s) failed the test-signal check.\n` +
    'Assert on BEHAVIOUR (what breaks for a user) instead of on the declaration.\n' +
    'FK cascade/restrict assertions are exempt — they encode a consequence.\n',
);
process.exit(1);
