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
import { FS_LISTING_CALLS, fsListing, spawnCwd } from './whole-tree-gates.mjs';
import { gitConfigFiles } from './whole-tree-git.mjs';
import { physical } from './whole-tree-paths.mjs';
import { subprocessListing } from './whole-tree-shell.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repository root by its realpath, the one spelling every placement is compared against. */
export const ROOT = physical(resolve(HERE, '..', '..')) ?? resolve(HERE, '..', '..');
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
/** Worker execArgv that runs a module before the worker's first line, where the watch installs. */
const WORKER_STARTUP = new Set([
  '--require',
  '-r',
  '--import',
  '--loader',
  '--experimental-loader',
]);

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

/** NODE_OPTIONS with the preload added once, at the front so it runs before any test-supplied module. */
export function withPreload(options = '') {
  if (options.includes(PRELOAD)) return options;
  return `--import=${PRELOAD} ${options}`.trim();
}

function wrap(original, name, read, custom = original[promisify.custom]) {
  const watched = function watched(...args) {
    const state = globalThis[WATCH];
    const handed = read(name, args) ?? args;
    // A spawner that calls another (`exec` runs `execFile`, each runs `ChildProcess#spawn`) was read
    // by the outermost, so what it calls in turn is not read twice.
    state.depth += 1;
    try {
      return original.apply(this, handed);
    } finally {
      state.depth -= 1;
    }
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

/** What one spawner call runs: its program and argv, the options, and how a shell reads them. */
export function spawnCall(name, args) {
  const [command, second] = args;
  const list = Array.isArray(second) ? second : [];
  const at = args.findIndex((a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a));
  const opts = at === -1 ? {} : args[at];
  const isFork = name === 'fork';
  // `exec`/`execSync` always run /bin/sh; `shell: true` runs it; a `shell` naming a program keeps
  // that string, which the reader refuses (only Node's own /bin/sh is admitted).
  const named = typeof opts.shell === 'string' && opts.shell !== '' ? opts.shell : null;
  const shell = isFork
    ? false
    : (named ?? (name === 'exec' || name === 'execSync' || Boolean(opts.shell)));
  const argv = isFork
    ? {
        command: String(opts.execPath ?? process.execPath),
        args: [String(command), ...list.map(String)],
      }
    : { command: String(command), args: list.map(String) };
  return {
    ...argv,
    shell,
    opts,
    at,
    fork: isFork,
    argv0: typeof opts.argv0 === 'string' ? opts.argv0 : null,
  };
}

/** One per process, whichever copy of this module installed it. */
const WATCH = Symbol.for('forge.whole-tree-watch');

/** The base the reader compares a spawn against, captured before any test ran: the environment, the
 * git config files it read then, and this Node's own startup argv. Written beside the log so every
 * child reads the same base rather than its own environment. */
function captureBase(logPath) {
  const env = { ...process.env };
  const configs = {};
  for (const file of gitConfigFiles(env)) {
    try {
      configs[file] = fs.readFileSync(file, 'utf8');
    } catch {}
  }
  env.__WT_BASE_EXECARGV = process.execArgv.join('\n');
  const base = { env, configs, execArgv: process.execArgv };
  try {
    fs.writeFileSync(`${logPath}.base.json`, JSON.stringify(base));
  } catch {}
  return base;
}

/** Reads what `captureBase` wrote from `<log>.base.json`; where the file is absent it falls back to
 * this process's own state. */
function readBase(logPath) {
  try {
    return JSON.parse(fs.readFileSync(`${logPath}.base.json`, 'utf8'));
  } catch {
    const env = { ...process.env, __WT_BASE_EXECARGV: process.execArgv.join('\n') };
    return { env, configs: {}, execArgv: process.execArgv };
  }
}

/**
 * Wraps the listing calls and spawners once per process, telling `onListing` each `{ dir, via, at }`.
 * A spawned process and a file worker get the preload; a worker handed its own startup module is
 * counted as the root, since it runs before the watch installs there.
 */
export function installWatch(onListing, logPath, isBase = false) {
  globalThis[WATCH] ??= { installed: false, onListing: null, depth: 0, base: null };
  globalThis[WATCH].depth ??= 0;
  const state = globalThis[WATCH];
  state.onListing = onListing;
  process.env[LOG_ENV] = logPath;
  process.env.NODE_OPTIONS = withPreload(process.env.NODE_OPTIONS);
  if (state.installed) return;
  state.installed = true;
  // The guard captures the base the moment it installs, before any test runs. Every child reads
  // what the guard wrote, so it is compared against the worker's environment, not its own.
  state.base = isBase ? captureBase(logPath) : readBase(logPath);
  const tell = (entries) => {
    const at = callSite();
    if (entries.length > 0) state.onListing(entries.map(({ program, ...e }) => ({ ...e, at })));
  };
  const unreadable = (name) => [
    {
      dir: ROOT,
      via: `${name}() with an argument the guard cannot place (not a path, or a glob climbing after a wildcard), so counted as the root`,
    },
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
    if (state.depth > 0) return args;
    const call = spawnCall(name, args);
    let entries;
    try {
      const cwd = spawnCwd(call.opts.cwd, process.cwd());
      const env = call.opts.env ?? process.env;
      const base = { ...state.base, hasFrame: callSite() !== null };
      const found = subprocessListing({ ...call, cwd, root: ROOT, env, base });
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
  // A `ChildProcess` spawned directly goes round every exported spawner: its normalized options are
  // read here, its `args[0]` is the `argv0` a direct spawn carries, and the preload is added.
  const proto = childProcess.ChildProcess.prototype;
  const spawnChild = proto.spawn;
  proto.spawn = function watchedSpawn(options) {
    if (state.depth > 0 || options === null || typeof options !== 'object')
      return spawnChild.call(this, options);
    const pairs = Array.isArray(options.envPairs) ? options.envPairs.map(String) : null;
    const env = pairs
      ? Object.fromEntries(
          pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]),
        )
      : process.env;
    let entries;
    try {
      const cwd = spawnCwd(options.cwd, process.cwd());
      const argv = Array.isArray(options.args) ? options.args.map(String) : [];
      const base = { ...state.base, hasFrame: callSite() !== null };
      const found = subprocessListing({
        command: String(options.file),
        args: argv.slice(1),
        cwd,
        root: ROOT,
        env,
        opts: readOpts(options),
        argv0: argv[0] ?? null,
        base,
      });
      entries = found.map((e) => ({ ...e, via: `ChildProcess#spawn() running ${e.via}` }));
    } catch {
      entries = unreadable('ChildProcess#spawn');
    }
    tell(entries);
    if (pairs === null) return spawnChild.call(this, options);
    const kept = pairs.filter(
      (p) => !p.startsWith('NODE_OPTIONS=') && !p.startsWith(`${LOG_ENV}=`),
    );
    const envPairs = [
      ...kept,
      `NODE_OPTIONS=${withPreload(env.NODE_OPTIONS)}`,
      `${LOG_ENV}=${process.env[LOG_ENV]}`,
    ];
    return spawnChild.call(this, { ...options, envPairs });
  };
  const Worker = workerThreads.Worker;
  // Node runs an `execArgv` preload for a file worker and not for an `eval` one, whose source is a
  // CommonJS script: that source is handed the preload as its first line instead.
  workerThreads.Worker = class WatchedWorker extends Worker {
    constructor(code, options = {}) {
      const startup = (options.execArgv ?? []).filter(
        (a) =>
          typeof a === 'string' && (WORKER_STARTUP.has(a) || WORKER_STARTUP.has(a.split('=')[0])),
      );
      if (startup.length > 0)
        state.onListing([
          {
            dir: ROOT,
            via: `Worker() with the startup option \`${startup[0]}\`, which runs before the watch, so counted as the root`,
            at: callSite(),
          },
        ]);
      if (options.eval)
        super(`require(${JSON.stringify(fileURLToPath(PRELOAD))});\n${code}`, options);
      else
        super(code, {
          ...options,
          execArgv: ['--import', PRELOAD, ...(options.execArgv ?? process.execArgv)],
        });
    }
  };
  syncBuiltinESMExports();
}

/** The spawn options a direct `ChildProcess` carries that the grammar rules on: only a set `uid` or
 * `gid`. `argv0` reaches the reader as `args[0]`, and the rest of the normalized options change no
 * execution. */
function readOpts(options) {
  const out = {};
  for (const k of ['uid', 'gid'])
    if (options[k] !== undefined && options[k] !== null) out[k] = options[k];
  return out;
}
