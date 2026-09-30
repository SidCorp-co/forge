// The vitest setup file every config names: it fails a file in `afterAll` when what the file ran
// listed a directory covering the repository root and it does not declare `@gate-input whole-tree`
// (ISS-1314). It reads calls, not source, bar the file's own `import.meta.glob`, which vite expands
// before the file runs. It cannot see a listing the run never executes, native code, or a listing
// delegated to a process the test did not start: docs/proposals/a-test-reading-a-named-file-*.md.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, expect } from 'vitest';
import { GLOB_CALL_RE, globListings, guardVerdict } from './whole-tree-gates.mjs';
import { installWatch, ROOT } from './whole-tree-watch.mjs';

const KEY = Symbol.for('forge.whole-tree-guard');

globalThis[KEY] ??= { installed: false, hits: [], log: null };
const state = globalThis[KEY];
state.hits = [];
if (!state.installed) {
  state.installed = true;
  state.log = join(mkdtempSync(join(tmpdir(), 'whole-tree-guard-')), 'children.jsonl');
  writeFileSync(state.log, '');
  installWatch((entries) => state.hits.push(...entries), state.log, true);
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

/** The file's own globs, read with the TypeScript compiler core declares, loaded only on a match. */
function globHits(source, filepath) {
  if (!GLOB_CALL_RE.test(source)) return [];
  const ts = createRequire(join(ROOT, 'packages/core/package.json'))('typescript');
  return globListings({ source, file: filepath, root: ROOT, ts });
}

afterAll(() => {
  const filepath = expect.getState().testPath;
  const hits = [...state.hits, ...childHits()];
  state.hits = [];
  if (!filepath) return;
  let source = '';
  try {
    source = readFileSync(filepath, 'utf8');
  } catch {
    return;
  }
  hits.push(...globHits(source, filepath));
  if (hits.length === 0) return;
  const refusal = guardVerdict({ file: relative(ROOT, filepath), source, hits, root: ROOT });
  if (refusal) throw new Error(refusal);
});
