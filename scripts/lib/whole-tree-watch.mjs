// The watch the root-walk guard installs in a vitest worker, and its preload installs in every Node
// process and worker thread a test starts: each `node:fs` listing call and each spawned program is
// read for the directories it lists, and `onListing` is told of each.

import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import workerThreads from 'node:worker_threads';
import { FS_LISTING_CALLS, fsListing, subprocessListing } from './whole-tree-gates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
export const LOG_ENV = 'FORGE_WHOLE_TREE_LOG';
const PRELOAD = pathToFileURL(resolve(HERE, 'whole-tree-child.mjs')).href;
const OWN = new Set(
  [
    'whole-tree-watch.mjs',
    'whole-tree-guard.mjs',
    'whole-tree-child.mjs',
    'whole-tree-gates.mjs',
  ].map((f) => resolve(HERE, f)),
);
const SPAWNERS = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'];

/** The first stack frame outside node's internals, node_modules and the watch's own files. */
export function callSite() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  for (const line of stack.split('\n').slice(1)) {
    const m = line.match(/(?:\(|at )((?:file:\/\/)?\/[^():]+):(\d+):\d+\)?$/);
    if (!m) continue;
    const path = m[1].startsWith('file://') ? fileURLToPath(m[1]) : m[1];
    if (OWN.has(path) || path.includes('/node_modules/')) continue;
    return `${path.startsWith(`${ROOT}/`) ? relative(ROOT, path) : path}:${m[2]}`;
  }
  return null;
}

/** NODE_OPTIONS with the preload added once. */
export function withPreload(options = '') {
  return options.includes(PRELOAD) ? options : `${options} --import=${PRELOAD}`.trim();
}

function wrap(original, name, read, custom = original[promisify.custom]) {
  const watched = function watched(...args) {
    return original.apply(this, read(name, args) ?? args);
  };
  // `exec` and `execFile` carry a `util.promisify.custom`, without which `promisify` would resolve
  // to stdout alone: the wrapper keeps every property, and watches the promisified form as well.
  for (const key of Reflect.ownKeys(original)) {
    if (['length', 'name', 'prototype', promisify.custom].includes(key)) continue;
    Object.defineProperty(watched, key, Object.getOwnPropertyDescriptor(original, key));
  }
  if (typeof custom === 'function') watched[promisify.custom] = wrap(custom, name, read, null);
  return watched;
}

function spawnCall(name, args) {
  const [command, second] = args;
  const list = Array.isArray(second) ? second.map(String) : [];
  const at = args.findIndex((a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a));
  const opts = at === -1 ? {} : args[at];
  const shell = name === 'exec' || name === 'execSync' || Boolean(opts.shell);
  const argv =
    name === 'fork'
      ? { command: process.execPath, args: [String(command), ...list] }
      : { command: String(command), args: list };
  return { ...argv, shell, opts, at };
}

/** One per process, whichever copy of this module installed it: the child preload loads it
 * through Node and a vitest worker through vitest's runner. */
const WATCH = Symbol.for('forge.whole-tree-watch');

/**
 * Wraps the listing calls and the spawners once per process, and tells `onListing(entries)` of
 * every `{ dir, via, at }` a call lists. A later call only moves where listings go, so a vitest
 * worker started under a parent's preload reports to its own guard and not outward. A spawned
 * process and a file worker get the preload, a call handing its own `env` included.
 */
export function installWatch(onListing, logPath) {
  globalThis[WATCH] ??= { installed: false, onListing: null };
  const state = globalThis[WATCH];
  state.onListing = onListing;
  process.env[LOG_ENV] = logPath;
  process.env.NODE_OPTIONS = withPreload(process.env.NODE_OPTIONS);
  if (state.installed) return;
  state.installed = true;
  const tell = (entries) => {
    if (entries.length === 0) return;
    const at = callSite();
    state.onListing(entries.map((e) => ({ ...e, at })));
  };
  const fsRead = (name, args) => {
    try {
      tell(fsListing(name, args, process.cwd()).map((dir) => ({ dir, via: `${name}()` })));
    } catch {
      // A listing the reader cannot parse is not a reason to break the test that made it.
    }
  };
  for (const name of FS_LISTING_CALLS) {
    if (typeof fs[name] === 'function') fs[name] = wrap(fs[name], name, fsRead);
  }
  for (const name of ['readdir', 'opendir', 'glob']) {
    if (typeof fs.promises[name] === 'function') {
      fs.promises[name] = wrap(fs.promises[name], name, fsRead);
    }
  }
  const spawnRead = (name, args) => {
    const call = spawnCall(name, args);
    try {
      const cwd = call.opts.cwd ? resolve(process.cwd(), String(call.opts.cwd)) : process.cwd();
      const found = subprocessListing({ ...call, cwd, root: ROOT });
      tell(found.map((e) => ({ dir: e.dir, via: `${name}() running ${e.via}` })));
    } catch {
      // As above.
    }
    if (call.at === -1 || !call.opts.env) return args;
    const env = {
      ...call.opts.env,
      NODE_OPTIONS: withPreload(call.opts.env.NODE_OPTIONS),
      [LOG_ENV]: process.env[LOG_ENV],
    };
    return args.map((a, i) => (i === call.at ? { ...call.opts, env } : a));
  };
  for (const name of SPAWNERS) childProcess[name] = wrap(childProcess[name], name, spawnRead);
  const Worker = workerThreads.Worker;
  // Node runs an `execArgv` preload for a file worker and not for an `eval` one, whose source is a
  // CommonJS script: that source is handed the preload as its first line instead.
  workerThreads.Worker = class WatchedWorker extends Worker {
    constructor(code, options = {}) {
      if (options.eval)
        super(`require(${JSON.stringify(fileURLToPath(PRELOAD))});\n${code}`, options);
      else
        super(code, {
          ...options,
          execArgv: [...(options.execArgv ?? process.execArgv), '--import', PRELOAD],
        });
    }
  };
  syncBuiltinESMExports();
}
