// The preload the watch hands every Node process and worker a test starts: a line naming the
// process, then each listing covering the repository root, one JSON line each on the parent's log.
// With no log there is nowhere to write either, so it refuses to let the program run at all.

import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { isMainThread, threadId } from 'node:worker_threads';
import { coversRoot } from './whole-tree-gates.mjs';
import { installWatch, LOG_ENV, ROOT } from './whole-tree-watch.mjs';

const log = process.env[LOG_ENV];
const where = isMainThread
  ? `child process ${process.pid}`
  : `worker ${threadId} of process ${process.pid}`;
if (!log) {
  throw new Error(
    `whole-tree guard: ${where} loaded the preload with no ${LOG_ENV} in its environment, so ` +
      'nothing it lists could reach the test that started it; it is stopped here rather than run ' +
      'unwatched. The watch arms every child and worker it starts with the log, so this one was ' +
      'started round it.',
  );
}
/** Append a line to the log, unless the worker that reads it has exited and removed it: a process
 * that outlives that worker writes for nobody, and is counted as the root by the file it outlived. */
function write(line) {
  try {
    appendFileSync(log, line);
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
}
if (isMainThread) write(`${JSON.stringify({ started: process.pid })}\n`);
installWatch(
  (entries) => {
    for (const e of entries) {
      if (!coversRoot(ROOT, e.dir)) continue;
      write(`${JSON.stringify({ ...e, via: `${e.via} in ${where}` })}\n`);
    }
  },
  log,
  false,
);
