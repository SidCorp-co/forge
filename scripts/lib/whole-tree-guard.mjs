// The vitest setup file every config names: it fails a file in `afterAll` when what the file ran
// listed a directory covering the repository root and it does not declare `@gate-input whole-tree`
// (ISS-1314). It reads calls, not source, bar the file's own `import.meta.glob`, which vite expands
// before the file runs. It cannot see a listing the run never executes, native code, or a listing
// delegated to a process the test did not start: docs/proposals/a-test-reading-a-named-file-*.md.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, expect } from 'vitest';
import {
  declaresWholeTree,
  GLOB_CALL_RE,
  globListings,
  guardVerdict,
  logLines,
} from './whole-tree-gates.mjs';
import { installWatch, ROOT } from './whole-tree-watch.mjs';

const KEY = Symbol.for('forge.whole-tree-guard');
/** How long a file's end waits for a process or worker it started to finish before counting it. */
const GRACE_MS = 5000;

globalThis[KEY] ??= { installed: false, hits: [], late: [], log: null, dir: null, files: 0 };
const state = globalThis[KEY];
state.late ??= [];
// What reached the watch after the last file ended was that file's: judged here, naming where it
// was called, unless that file declared itself.
state.hits = state.endedDeclared
  ? []
  : state.late.map((h) => ({ ...h, via: `${h.via} after ${state.ended} ended` }));
state.late = [];
state.ended = null;
state.dir ??= mkdtempSync(join(tmpdir(), 'whole-tree-guard-'));
// Each file gets its own log, so a child one file left running writes where no later file reads.
state.files = (state.files ?? 0) + 1;
state.log = join(state.dir, `children-${state.files}.jsonl`);
writeFileSync(state.log, '');
state.offset = 0;
// A worker a file before this one started and left running is that file's, not this one's.
state.workersBefore = new Set(globalThis[Symbol.for('forge.whole-tree-watch')]?.workers ?? []);
installWatch(
  (entries) => (state.ended ? state.late : state.hits).push(...entries),
  state.log,
  !state.installed,
);
state.installed = true;

/** The whole lines this file's processes wrote since the last read; the log is never emptied. */
function readLog() {
  let bytes;
  try {
    bytes = readFileSync(state.log);
  } catch {
    return [];
  }
  const { lines, offset } = logLines(bytes, state.offset);
  state.offset = offset;
  return lines;
}

/** Whether a process is still running: signalable and not a zombie waiting to be reaped. */
function running(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e?.code === 'EPERM';
  }
  try {
    return !/^\d+ \(.*\) Z /s.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return !existsSync('/proc/self');
  }
}

/** The listings this file's processes and workers made, waiting out any still running; one still
 * running at the end counts as the root, since what it lists afterwards no file reads. */
async function childHits() {
  const hits = [];
  const pids = new Set();
  // Drained on every wait, so a process started while the file's end waits is waited on as well.
  const drain = () => {
    for (const line of readLog()) {
      if (line.started) pids.add(line.started);
      else hits.push(line);
    }
  };
  drain();
  const all = globalThis[Symbol.for('forge.whole-tree-watch')]?.workers ?? new Set();
  const mine = () => [...all].filter((w) => !state.workersBefore.has(w));
  const live = () => [...pids].filter(running);
  const deadline = Date.now() + GRACE_MS;
  while ((live().length > 0 || mine().length > 0) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 50));
    drain();
  }
  // Liveness is read before each last drain, and again while a drain finds a process it did not
  // know: one found gone has written all it ever will, so nothing it started is missed.
  let stillLive = live();
  for (let known = pids.size; ; known = pids.size) {
    drain();
    if (pids.size === known) break;
    stillLive = live();
  }
  for (const pid of stillLive)
    hits.push({
      dir: ROOT,
      via: `child process ${pid} was still running when the file ended, so what it lists afterwards is read by nobody and counted as the root`,
      at: null,
    });
  if (mine().length > 0)
    hits.push({
      dir: ROOT,
      via: `${mine().length} worker thread(s) were still running when the file ended, so what they list afterwards is read by nobody and counted as the root`,
      at: null,
    });
  return hits;
}

/** The file's own globs, read with the TypeScript compiler core declares, loaded only on a match. */
function globHits(source, filepath) {
  if (!GLOB_CALL_RE.test(source)) return [];
  const ts = createRequire(join(ROOT, 'packages/core/package.json'))('typescript');
  return globListings({ source, file: filepath, root: ROOT, ts });
}

afterAll(async () => {
  const filepath = expect.getState().testPath;
  const children = await childHits();
  const hits = [...state.hits, ...children];
  state.hits = [];
  state.ended = filepath ? relative(ROOT, filepath) : 'a file';
  state.endedDeclared = false;
  if (!filepath) return;
  let source = '';
  try {
    source = readFileSync(filepath, 'utf8');
  } catch {
    return;
  }
  state.endedDeclared = declaresWholeTree(source);
  hits.push(...globHits(source, filepath));
  if (hits.length === 0) return;
  const refusal = guardVerdict({ file: relative(ROOT, filepath), source, hits, root: ROOT });
  if (refusal) throw new Error(refusal);
}, GRACE_MS + 10_000);
