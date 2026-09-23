#!/usr/bin/env node
// Per-file comment budget for the four rules that own comment CONTENT.
//
// eslint-plugin-code-quality (.forge/code-quality) owns the rules; this adds none. What it
// adds is the baseline ESLint has no concept of, so an axis carrying real debt has only two
// settings — every build red, or nothing holds. Same shape, and same reasoning, as
// check-size-budget.mjs and check-lint-budget.mjs: freeze today per FILE per RULE, block
// tomorrow. A file may keep its findings, may lose them, may never gain one.
//
// It reads the project's own eslint.config.mjs, so what is measured is what the project
// enabled. A rule it switched off is named rather than counted as clean.
//
// Modes: --all (CI) · --staged (freeze-only) · --update-baseline
// Exit: 0 clean · 1 a file gained a finding · 2 could not run.

import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMENT_RULES, silentRules, tally } from './lib/comment-budget.mjs';
import {
  freezeFaults,
  loadBaseline,
  parseMode,
  sortDeep,
  stagedFiles,
  total,
  writeBaseline,
} from './lib/debt-ratchet.mjs';
import { absentPrerequisites, remedyLines } from './lib/prerequisite.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, '.forge', 'comment-baseline.json');
const CONFIG_PATH = join(ROOT, 'eslint.config.mjs');

function die(reason) {
  console.error(`check-comment-budget: ${reason}`);
  process.exit(2);
}

const parsed = parseMode(
  process.argv,
  ['--all', '--staged', '--update-baseline'],
  'check-comment-budget.mjs',
);
if (parsed.error) die(parsed.error);
const mode = parsed.mode;

const missing = absentPrerequisites(ROOT, ['deps']);
if (missing.length > 0) die(`could not run — ${remedyLines(missing)[0]}`);
if (!existsSync(CONFIG_PATH)) die('eslint.config.mjs is absent — nothing declares these rules');

let ESLint;
try {
  ({ ESLint } = await import('eslint'));
} catch (err) {
  die(`eslint could not be loaded: ${err.message}`);
}

const eslint = new ESLint({ cwd: ROOT });

let results;
try {
  results = await eslint.lintFiles(['.']);
} catch (err) {
  die(`eslint could not read the tree: ${err.message}`);
}

const fatal = results.flatMap((r) => (r.messages ?? []).filter((m) => m.fatal));
if (fatal.length > 0) die(`eslint reported a parse error: ${fatal[0].message}`);

// A scope that matched nothing and a tree with no findings look identical by count, and the
// second is what this gate exists to distinguish. Refused rather than reported clean.
if (results.length === 0) die('eslint scanned 0 files — the config matched nothing');

let effective;
try {
  effective = await eslint.calculateConfigForFile(join(ROOT, 'eslint.config.mjs'));
} catch (err) {
  die(`eslint could not resolve its own config: ${err.message}`);
}
const silent = silentRules(effective);
if (silent.length > 0) {
  die(
    `${silent.join(', ')} is off in eslint.config.mjs.\n` +
      'A rule this axis owns that reports nothing because it was switched off is not a clean\n' +
      'axis, and by count it is indistinguishable from one. Re-enable it, or take it off\n' +
      "COMMENT_RULES in scripts/lib/comment-budget.mjs and say in .forge/conformance.json's\n" +
      'comment axis what stopped being measured.',
  );
}

const measured = tally(results, (file) => relative(ROOT, file));

if (mode === '--update-baseline') {
  const previous = loadBaseline(BASELINE_PATH);
  if (previous === null) die(`${BASELINE_PATH} is unreadable — refusing to overwrite it`);
  const files = sortDeep(measured);
  const original = previous.original ?? total(files);
  writeBaseline(BASELINE_PATH, { generatedAt: new Date().toISOString(), original, files });
  console.log(
    `comment-budget baseline written: ${Object.keys(files).length} file(s), ` +
      `${total(files)} finding(s) frozen of ${original} original`,
  );
  process.exit(0);
}

const baselineDoc = loadBaseline(BASELINE_PATH);
if (baselineDoc === null) die(`${BASELINE_PATH} is unreadable — refusing to report clean`);
const baseline = baselineDoc.files ?? {};

const frozen = total(baseline);
if (frozen > 0 && total(measured) === 0) {
  die(
    `the baseline freezes ${frozen} finding(s) and this run measured ZERO.\n` +
      'A tree that drained and a tree the rules stopped reaching look identical from here.\n' +
      'If it genuinely drained: node scripts/check-comment-budget.mjs --update-baseline',
  );
}

let staged = null;
if (mode === '--staged') {
  staged = stagedFiles(ROOT);
  if (staged.error) die(staged.error);
}

const failures = freezeFaults(measured, baseline, staged?.files ?? null);

console.log(
  `comment-budget: ${results.length} file(s) scanned, ${total(measured)} finding(s) ` +
    `frozen against the baseline across ${COMMENT_RULES.length} rule(s)`,
);
const original = baselineDoc.original;
if (typeof original === 'number' && original > 0) {
  const pct = Math.round(((original - total(measured)) / original) * 100);
  console.log(`  ${total(measured)} / ${original} original (${pct}% drained)`);
}
if (failures.length === 0) process.exit(0);

for (const { file, reasons } of failures) {
  console.error(`\n${file}`);
  for (const reason of reasons) console.error(`  ${reason}`);
}
console.error(
  `\n${failures.length} file(s) failed the comment budget.\n` +
    'A file already carrying comment debt may keep it, but it may not gain more, and a file\n' +
    'frozen at zero stays at zero. Read the finding in full with: pnpm lint:code-quality\n' +
    'Pay it by deleting the comment or stating the constraint once — never by widening a\n' +
    'limit, and never by rewording a directive another gate reads as its argument.\n' +
    'If the growth is deliberate, price it and re-freeze:\n' +
    '  node scripts/check-comment-budget.mjs --update-baseline\n',
);
process.exit(1);
