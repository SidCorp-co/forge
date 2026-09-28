// The preload the root-walk watch hands every Node process and worker thread a test starts: what it
// lists that covers the repository root is appended to the parent's log, one JSON line each.

import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { isMainThread, threadId } from 'node:worker_threads';
import { coversRoot } from './whole-tree-gates.mjs';
import { installWatch, LOG_ENV, ROOT } from './whole-tree-watch.mjs';

const log = process.env[LOG_ENV];
const where = isMainThread
  ? `child process ${process.pid}`
  : `worker ${threadId} of process ${process.pid}`;
if (log) {
  installWatch((entries) => {
    for (const e of entries) {
      if (!coversRoot(ROOT, e.dir)) continue;
      appendFileSync(log, `${JSON.stringify({ ...e, via: `${e.via} in ${where}` })}\n`);
    }
  }, log);
}
