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
import { FS_LISTING_CALLS, fsListing } from './whole-tree-gates.mjs';
import { subprocessListing } from './whole-tree-shell.mjs';

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
    'whole-tree-shell.mjs',
  ].map((f) => resolve(HERE, f)),
);
const SPAWNERS = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'];

/** Executables a dependency starts for itself, each read and found to list nothing it is not
 * asked to: esbuild's service transforms the files vite hands it. */
const TOOL_HELPERS = new Set(['esbuild']);

/** Whether `program` is a reviewed helper that lives under node_modules. */
export function isToolHelper(program) {
  const path = String(program ?? '');
  return path.includes('/node_modules/') && TOOL_HELPERS.has(path.slice(path.lastIndexOf('/') + 1));
}

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
  const list = Array.isArray(second) ? second : [];
  const at = args.findIndex((a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a));
  const opts = at === -1 ? {} : args[at];
  const shell = name === 'exec' || name === 'execSync' || Boolean(opts.shell);
  // `fork` runs `execPath`, which is Node unless the call names another program.
  const argv =
    name === 'fork'
      ? { command: String(opts.execPath ?? process.execPath), args: [String(command), ...list] }
      : { command: String(command), args: list.map(String) };
  return { ...argv, shell, opts, at };
}

/** One per process, whichever copy of this module installed it: the child preload loads it
 * through Node and a vitest worker through vitest's runner. */
const WATCH = Symbol.for('forge.whole-tree-watch');

/**
 * Wraps the listing calls and spawners once per process, telling `onListing` each `{ dir, via, at }`.
 * A later call only moves where listings go, so a vitest worker under a parent's preload reports to
 * its own guard. A spawned process and a file worker get the preload, even one handed its own env.
 */
export function installWatch(onListing, logPath) {
  globalThis[WATCH] ??= { installed: false, onListing: null };
  const state = globalThis[WATCH];
  state.onListing = onListing;
  process.env[LOG_ENV] = logPath;
  process.env.NODE_OPTIONS = withPreload(process.env.NODE_OPTIONS);
  if (state.installed) return;
  state.installed = true;
  // An unseen program counts wherever it started, but a reviewed helper no repository frame started:
  // a missing frame alone exempts nothing, since a dependency's callback can spawn for the test.
  const tell = (entries) => {
    const at = callSite();
    const kept = entries.filter((e) => !e.unseen || at !== null || !isToolHelper(e.program));
    if (kept.length > 0) state.onListing(kept.map(({ unseen, program, ...e }) => ({ ...e, at })));
  };
  // A call the reader throws on is a listing nobody can place, so it counts as the root.
  const unreadable = (name) => [
    { dir: ROOT, via: `${name}() with arguments the guard could not read, so counted as the root` },
  ];
  const fsRead = (name, args) => {
    let entries;
    try {
      entries = fsListing(name, args, process.cwd()).map((dir) =>
        dir === null ? unreadable(name)[0] : { dir, via: `${name}()` },
      );
    } catch {
      entries = unreadable(name);
    }
    tell(entries);
  };
  for (const name of FS_LISTING_CALLS) {
    if (typeof fs[name] === 'function') fs[name] = wrap(fs[name], name, fsRead);
  }
  for (const name of ['readdir', 'opendir', 'glob', 'cp']) {
    if (typeof fs.promises[name] === 'function') {
      fs.promises[name] = wrap(fs.promises[name], name, fsRead);
    }
  }
  const spawnRead = (name, args) => {
    const call = spawnCall(name, args);
    let entries;
    try {
      const cwd = call.opts.cwd ? resolve(process.cwd(), String(call.opts.cwd)) : process.cwd();
      const env = call.opts.env ?? process.env;
      const found = subprocessListing({ ...call, cwd, root: ROOT, env });
      entries = found.map((e) => ({ ...e, via: `${name}() running ${e.via}` }));
    } catch {
      entries = unreadable(name);
    }
    tell(entries);
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
