// The vitest setup file every config names: it fails a file in `afterAll` when what the file ran
// listed a directory covering the repository root and the file does not declare `@gate-input
// whole-tree` (ISS-1314). It reads calls, not source: each reading of the text was a list of
// spellings. It cannot see a listing the run never executes (the run that does is refused), nor an
// unreadable program reaching the root by a route none of its inputs spell.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, expect } from 'vitest';
import { guardVerdict } from './whole-tree-gates.mjs';
import { installWatch, ROOT } from './whole-tree-watch.mjs';

const KEY = Symbol.for('forge.whole-tree-guard');

globalThis[KEY] ??= { installed: false, hits: [], log: null };
const state = globalThis[KEY];
state.hits = [];
if (!state.installed) {
  state.installed = true;
  state.log = join(mkdtempSync(join(tmpdir(), 'whole-tree-guard-')), 'children.jsonl');
  writeFileSync(state.log, '');
  installWatch((entries) => state.hits.push(...entries), state.log);
}

/** What the processes this file started listed, read and emptied. */
function childHits() {
  let text = '';
  try {
    text = readFileSync(state.log, 'utf8');
    writeFileSync(state.log, '');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

afterAll(() => {
  const filepath = expect.getState().testPath;
  const hits = [...state.hits, ...childHits()];
  state.hits = [];
  if (!filepath || hits.length === 0) return;
  let source = '';
  try {
    source = readFileSync(filepath, 'utf8');
  } catch {
    return;
  }
  const refusal = guardVerdict({ file: relative(ROOT, filepath), source, hits, root: ROOT });
  if (refusal) throw new Error(refusal);
});
