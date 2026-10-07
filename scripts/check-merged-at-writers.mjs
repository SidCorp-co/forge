#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dieAs, ROOT, stripComments, walkFiles } from './lib/gate.mjs';

const die = dieAs('check-merged-at-writers');

const OWNER = 'packages/core/src/issues/merge-record.ts';
const ROOTS = ['packages/core/src', 'packages/web-v2/src'];
const SKIP_DIRS = ['node_modules', 'dist', 'coverage', '.next', '.turbo', 'drizzle'];
const COLUMNS = ['mergedAt', 'mergedCommitSha', 'mergedLanding', 'mergedArtifacts'];

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

export function faultsIn(rel, source) {
  const text = stripComments(source);
  const faults = [];

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
    /update\s+(?:only\s+)?"?issues"?[\s\S]{0,400}?\bset\b[\s\S]{0,600}?\bmerged_(?:at|commit_sha|landing|artifacts)\b/gi,
  )) {
    faults.push({ rel, line: lineOf(text, hit.index), how: 'raw SQL updates issues.merged_*' });
  }
  return faults;
}

const keep = (path, name) =>
  /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && path !== OWNER;

function main() {
  const mode = process.argv[2];
  if (mode !== '--all')
    die('the only mode is --all — a staged subset reports clean on a tree that is not');
  if (!existsSync(join(ROOT, OWNER))) {
    die(`${OWNER} is not there, so nothing owns these columns and this rule cannot be checked`);
  }

  const files = ROOTS.flatMap((rel) => walkFiles(rel, { skipDirs: SKIP_DIRS, keep }));
  if (files.length === 0) die(`no source files found under ${ROOTS.join(', ')}`);

  const faults = files.flatMap((rel) => faultsIn(rel, readFileSync(join(ROOT, rel), 'utf8')));

  if (faults.length > 0) {
    console.error(
      `check-merged-at-writers: ${faults.length} write(s) of issues.merged_at, ` +
        `issues.merged_commit_sha or issues.merged_landing outside ${OWNER}:\n`,
    );
    for (const f of faults) console.error(`  ${f.rel}:${f.line} — ${f.how}`);
    console.error(
      `\n${OWNER} is the one writer, and the reason is ISS-1073: a merge and a stamp that are two\n` +
        'operations are two records that can disagree, and a disagreement here dispatches an issue\n' +
        'against code that is not there. Route the write through `recordIssueMerge`, which takes\n' +
        'evidence of a merge (a commit and its time), a named landing outside git, or an assertion\n' +
        '(none of them), and decides which supersedes the other.',
    );
    process.exit(1);
  }

  console.log(`merged-at-writers: ${files.length} file(s) scanned, one writer`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
