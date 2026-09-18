#!/usr/bin/env node
// Refuse a write of `issues.merged_at` or `issues.merged_commit_sha` outside the one module.
//
// ISS-1073's first rule: ONE writer per truth. `merged_at` is the Layer-2
// dependency gate — NULL means the blocker has not landed, so every
// `kind=blocks` dependent stays ungated — and it had three writers, none of
// which read git. A merge and a stamp that are two operations are two records
// that can disagree, which is a thing this repository measured rather than
// feared.
//
// So the two columns have one module, `packages/core/src/issues/merge-record.ts`,
// and this refuses any other statement that writes either. A second writer is not
// wrong the day it lands: it is wrong the first time it disagrees with the first
// one, which is months later and reads as a dependent dispatched against code
// that is not there.
//
// ## What it holds, and what it cannot
//
// Two shapes are matched, both with comments stripped first:
//
//   A. a drizzle `.update(issues)` / `.insert(issues)` whose value object names
//      `mergedAt` or `mergedCommitSha`;
//   B. raw SQL running `UPDATE issues ... SET ... merged_at`.
//
// What it cannot hold: a write assembled from a variable the scan cannot follow
// — `db.update(tbl)` where `tbl` was chosen at runtime, or SQL built by string
// concatenation. Neither shape exists in this repository today and both would
// be a defect on their own terms; this is a gate against the ordinary edit, not
// against somebody working around it. A checker that claimed otherwise would be
// the second kind of lie this rule exists to stop.
//
// Modes: --all (CI, the only mode — the rule is repo-wide and a staged subset
// would report clean on a tree that is not)
// Exit: 0 clean · 1 a write outside the owner · 2 could not run.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'packages/core/src/issues/merge-record.ts';
const ROOTS = ['packages/core/src', 'packages/web-v2/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.next', '.turbo', 'drizzle']);
const COLUMNS = ['mergedAt', 'mergedCommitSha'];

function die(message) {
  console.error(`check-merged-at-writers: ${message}`);
  process.exit(2);
}

/** Comments removed, so the many `cm:guard`s that NAME these columns are not writes. */
// cm:guard stripping comes first and is not optional: this repository documents its invariants in prose beside the code, so every guard that names `merged_at` would be a violation under a scan that read comments. Replacing them with spaces rather than deleting keeps every offset, which is what lets the report name a line number a reader can open.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function faultsIn(rel, source) {
  const text = stripComments(source);
  const faults = [];

  // A — a drizzle write whose value object names either column.
  for (const hit of text.matchAll(/\.(update|insert)\(\s*issues\s*\)/g)) {
    const from = hit.index + hit[0].length;
    const window = text.slice(from, from + 900);
    const stop = window.search(/\.(where|returning|onConflict|from)\s*\(/);
    const values = stop === -1 ? window : window.slice(0, stop);
    for (const column of COLUMNS) {
      if (new RegExp(`\\b${column}\\s*:`).test(values)) {
        faults.push({
          rel,
          line: lineOf(text, hit.index),
          how: `.${hit[1]}(issues) sets ${column}`,
        });
      }
    }
  }

  // B — raw SQL updating the table.
  for (const hit of text.matchAll(
    /update\s+(?:only\s+)?"?issues"?[\s\S]{0,400}?\bset\b[\s\S]{0,600}?\bmerged_(?:at|commit_sha)\b/gi,
  )) {
    faults.push({ rel, line: lineOf(text, hit.index), how: 'raw SQL updates issues.merged_*' });
  }
  return faults;
}

function walk(rel, acc) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return acc;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path, acc);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    // cm:guard tests are out of scope, and that is the same carve-out `check-provider-literals.mjs` makes for the same reason: a test PROVING the writer refuses a second write has to name the columns, and a scan that refused it would refuse the evidence for its own rule.
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
    if (path === OWNER) continue;
    acc.push(path);
  }
  return acc;
}

const mode = process.argv[2];
if (mode !== '--all')
  die('the only mode is --all — a staged subset reports clean on a tree that is not');
if (!existsSync(join(ROOT, OWNER))) {
  die(`${OWNER} is not there, so nothing owns these columns and this rule cannot be checked`);
}

const files = ROOTS.reduce((acc, rel) => walk(rel, acc), []);
if (files.length === 0) die('no source files found under ' + ROOTS.join(', '));

const faults = files.flatMap((rel) => faultsIn(rel, readFileSync(join(ROOT, rel), 'utf8')));

if (faults.length > 0) {
  console.error(
    `check-merged-at-writers: ${faults.length} write(s) of issues.merged_at or ` +
      `issues.merged_commit_sha outside ${OWNER}:\n`,
  );
  for (const f of faults) console.error(`  ${f.rel}:${f.line} — ${f.how}`);
  console.error(
    `\n${OWNER} is the one writer, and the reason is ISS-1073: a merge and a stamp that are two\n` +
      'operations are two records that can disagree, and a disagreement here dispatches an issue\n' +
      'against code that is not there. Route the write through `recordIssueMerge`, which takes\n' +
      'evidence of a merge (a commit and its time) or an assertion (neither), and decides which of\n' +
      'the two supersedes the other.',
  );
  process.exit(1);
}

console.log(`merged-at-writers: ${files.length} file(s) scanned, one writer`);
