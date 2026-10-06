// The watch the root-walk guard installs in a vitest worker, and its preload installs in every Node
// process and worker thread a test starts: each `node:fs` listing call and each spawned program is
// read for the directories it lists, and `onListing` is told of each.

import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import workerThreads from 'node:worker_threads';
import { FS_LISTING_CALLS, fsListing, spawnCwd } from './whole-tree-gates.mjs';
import {
  gitConfigFiles,
  physical,
  startupModuleKey,
  subprocessListing,
} from './whole-tree-shell.mjs';

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

function wrap(original, name, read, nests, custom = original[promisify.custom]) {
  const watched = function watched(...args) {
    const state = globalThis[WATCH];
    const handed = read(name, args) ?? args;
    // A spawner that calls another (`exec` runs `execFile`, each runs `ChildProcess#spawn`) was read
    // by the outermost, so what it calls in turn is not read twice. A listing call raises nothing:
    // a spawn made from inside one, as a `cpSync` filter may, is read like any other.
    if (nests) state.depth += 1;
    try {
      return original.apply(this, handed);
    } finally {
      if (nests) state.depth -= 1;
    }
  };
  // `exec` and `execFile` carry a `util.promisify.custom`, without which `promisify` would resolve
  // to stdout alone: the wrapper keeps every property, and watches the promisified form as well.
  for (const key of Reflect.ownKeys(original)) {
    if (['length', 'name', 'prototype', promisify.custom].includes(key)) continue;
    Object.defineProperty(watched, key, Object.getOwnPropertyDescriptor(original, key));
  }
  if (typeof custom === 'function')
    watched[promisify.custom] = wrap(custom, name, read, nests, null);
  return watched;
}

/** Where a spawner takes its options when the call hands none: after the command, and after the
 * argument list where the spawner takes one. */
function optionsAt(name, args) {
  if (name === 'exec' || name === 'execSync') return 1;
  return Array.isArray(args[1]) ? 2 : 1;
}

/** The call's arguments with its options copied to plain data and an explicit `env` that carries the
 * preload and the log, whatever the test did to `process.env`: a child is watched even where the
 * test deleted `NODE_OPTIONS`, and nothing the test wrote runs while Node reads the copy. */
export function armed(name, args, at, log) {
  const out = [...args];
  let index = at;
  if (index === -1) {
    index = optionsAt(name, out);
    if (typeof out[index] === 'function') out.splice(index, 0, {});
    else if (out[index] === undefined || out[index] === null) out[index] = {};
    else return out;
  }
  const opts = { ...out[index] };
  const env = { ...(opts.env ?? process.env) };
  env.NODE_OPTIONS = withPreload(env.NODE_OPTIONS);
  env[LOG_ENV] = log;
  out[index] = { ...opts, env };
  return out;
}

/** A worker's `env` armed with the log and the preload as `armed()` arms a child's; under
 * `SHARE_ENV` the worker reads the test's own `process.env`, so that is re-armed instead. */
export function armedWorkerEnv(env, log) {
  if (env === workerThreads.SHARE_ENV) {
    process.env.NODE_OPTIONS = withPreload(process.env.NODE_OPTIONS);
    process.env[LOG_ENV] = log;
    return env;
  }
  const out = { ...(env ?? process.env) };
  out.NODE_OPTIONS = withPreload(out.NODE_OPTIONS);
  out[LOG_ENV] = log;
  return out;
}

/** An `envPairs` list with the preload first in `NODE_OPTIONS` and the log set, as a child reads it. */
function armedPairs(pairs, log) {
  const env = Object.fromEntries(
    pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]),
  );
  const kept = pairs.filter((p) => !p.startsWith('NODE_OPTIONS=') && !p.startsWith(`${LOG_ENV}=`));
  return [...kept, `NODE_OPTIONS=${withPreload(env.NODE_OPTIONS)}`, `${LOG_ENV}=${log}`];
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

/** Where the base sits: one file in the log's directory, which every file's log shares. */
const basePath = (logPath) => join(dirname(logPath), 'base.json');

/** The base the reader compares a spawn against, captured before any test ran: the environment, the
 * git config files it read then, and this Node's own startup argv. */
function captureBase() {
  const env = { ...process.env };
  const configs = {};
  for (const file of gitConfigFiles(env)) {
    try {
      configs[file] = fs.readFileSync(file, 'utf8');
    } catch {}
  }
  env.__WT_BASE_EXECARGV = process.execArgv.join('\n');
  return { env, configs, execArgv: [...process.execArgv] };
}

/** Reads what the guard wrote to `base.json`; where the file is absent it falls back to this
 * process's own state. */
function readBase(logPath) {
  try {
    return JSON.parse(fs.readFileSync(basePath(logPath), 'utf8'));
  } catch {
    const env = { ...process.env, __WT_BASE_EXECARGV: process.execArgv.join('\n') };
    return { env, configs: {}, execArgv: [...process.execArgv] };
  }
}

/** Whether a worker's eval source is a script, which Node runs as CommonJS: anything else it runs as
 * a module, whose static imports load before any line the watch could put first. */
function isScript(code) {
  try {
    new vm.Script(String(code));
    return true;
  } catch {
    return false;
  }
}

/**
 * Wraps the listing calls and spawners once per process, telling `onListing` each `{ dir, via, at }`.
 * Every spawned process and file worker gets the preload, whatever the test did to its own
 * environment. What reaches `node:fs` or a process round the wrappers — a raw binding, `execve`, a
 * worker handed its own startup module — is counted as the root.
 */
export function installWatch(onListing, logPath, isBase = false) {
  globalThis[WATCH] ??= {
    installed: false,
    onListing: null,
    depth: 0,
    base: null,
    workers: new Set(),
  };
  const state = globalThis[WATCH];
  state.depth ??= 0;
  state.workers ??= new Set();
  state.onListing = onListing;
  state.log = logPath;
  process.env[LOG_ENV] = logPath;
  process.env.NODE_OPTIONS = withPreload(process.env.NODE_OPTIONS);
  if (!state.installed) {
    state.installed = true;
    // The guard captures the base the moment it installs, before any test runs. Every child reads
    // what the guard wrote, so it is compared against the worker's environment, not its own.
    state.base = isBase ? captureBase() : readBase(logPath);
    install(state);
  }
  if (isBase && !fs.existsSync(basePath(logPath))) {
    try {
      fs.writeFileSync(basePath(logPath), JSON.stringify(state.base));
    } catch {}
  }
}

function install(state) {
  const tell = (entries) => {
    const at = callSite();
    if (entries.length > 0) state.onListing(entries.map(({ program, ...e }) => ({ ...e, at })));
  };
  const asRoot = (via) =>
    tell([{ dir: ROOT, via: `${via}, so counted as the root`, unseen: true }]);
  const unreadable = (name) => [
    {
      dir: ROOT,
      via: `${name}() with an argument the guard cannot place (not a path, or a glob climbing after a wildcard), so counted as the root`,
      unseen: true,
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
    if (typeof fs[name] === 'function') fs[name] = wrap(fs[name], name, fsRead, false);
  }
  for (const name of ['readdir', 'opendir', 'glob', 'cp']) {
    if (typeof fs.promises[name] === 'function') {
      fs.promises[name] = wrap(fs.promises[name], name, fsRead, false);
    }
  }
  const readSpawn = (call, via) => {
    let entries;
    try {
      const cwd = spawnCwd(call.cwd, process.cwd());
      const base = { ...state.base, hasFrame: callSite() !== null };
      const found = subprocessListing({ ...call, cwd, root: ROOT, base });
      entries = found.map((e) => ({ ...e, via: `${via} running ${e.via}` }));
    } catch {
      entries = unreadable(via.replace(/\(\)$/, ''));
    }
    tell(entries);
  };
  const spawnRead = (name, args) => {
    if (state.depth > 0) return args;
    const call = spawnCall(name, args);
    readSpawn({ ...call, cwd: call.opts.cwd, env: call.opts.env ?? process.env }, `${name}()`);
    return armed(name, args, call.at, state.log);
  };
  for (const name of SPAWNERS) childProcess[name] = wrap(childProcess[name], name, spawnRead, true);
  // Every asynchronous spawn ends in `ChildProcess#spawn`, and every synchronous one in the
  // `spawn_sync` binding: each is read there unless an exported spawner already read it, so a
  // spawner a dependency captured before the watch installed is read all the same, and each is
  // re-armed with the preload whatever the spawner above it did.
  const readNormalized = (options, via) => {
    const pairs = pairsOf(options);
    const env = Object.fromEntries(
      pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]),
    );
    const argv = Array.isArray(options.args) ? options.args.map(String) : [];
    readSpawn(
      {
        command: String(options.file),
        args: argv.slice(1),
        cwd: options.cwd,
        env,
        opts: readOpts(options),
        argv0: argv[0] ?? null,
      },
      via,
    );
  };
  const proto = childProcess.ChildProcess.prototype;
  const spawnChild = proto.spawn;
  proto.spawn = function watchedSpawn(options) {
    if (options === null || typeof options !== 'object') return spawnChild.call(this, options);
    if (state.depth === 0) readNormalized(options, 'ChildProcess#spawn()');
    const pairs = pairsOf(options);
    const result = spawnChild.call(this, { ...options, envPairs: armedPairs(pairs, state.log) });
    // On the log before this returns, however late the child starts; esbuild's service outlives files.
    if (typeof this.pid === 'number' && !isEsbuildService(options)) {
      try {
        fs.appendFileSync(state.log, `${JSON.stringify({ started: this.pid })}\n`);
      } catch (e) {
        asRoot(`child process ${this.pid} could not be put on the log (${e?.code ?? 'unknown'})`);
      }
    }
    return result;
  };
  const binding = process.binding;
  const spawnSync = binding.call(process, 'spawn_sync');
  const syncSpawn = spawnSync.spawn;
  spawnSync.spawn = function watchedSyncSpawn(options) {
    if (options === null || typeof options !== 'object') return syncSpawn.call(this, options);
    if (state.depth === 0) readNormalized(options, 'spawn_sync binding');
    const pairs = pairsOf(options);
    return syncSpawn.call(this, { ...options, envPairs: armedPairs(pairs, state.log) });
  };
  process.binding = function watchedBinding(name) {
    if (RAW_BINDINGS.has(String(name)))
      asRoot(
        `process.binding('${name}') reaches ${RAW_BINDINGS.get(String(name))} round the watch`,
      );
    return binding.call(this, name);
  };
  if (typeof process.execve === 'function') {
    const execve = process.execve;
    process.execve = function watchedExecve(...args) {
      asRoot(
        `process.execve() replaces this process with \`${String(args[0])}\`, which the watch cannot see into`,
      );
      return execve.apply(this, args);
    };
  }
  const Worker = workerThreads.Worker;
  // A file worker and a module `eval` worker run an `execArgv` preload before their first line; a
  // script `eval` worker does not, so its source is handed the preload as its first line instead.
  workerThreads.Worker = class WatchedWorker extends Worker {
    constructor(code, options = {}) {
      const handed = options.execArgv ?? process.execArgv;
      const startup = foreignStartup(handed, state.base);
      if (startup !== null)
        asRoot(`Worker() with the startup module \`${startup}\`, which runs before the watch`);
      const execArgv = ['--import', PRELOAD, ...withoutOwnPreload(handed)];
      const env = armedWorkerEnv(options.env, state.log);
      if (options.eval && isScript(code))
        super(`require(${JSON.stringify(fileURLToPath(PRELOAD))});\n${code}`, { ...options, env });
      else super(code, { ...options, execArgv, env });
      state.workers.add(this);
      this.once('exit', () => state.workers.delete(this));
    }
  };
  syncBuiltinESMExports();
}

/** A normalized spawn's environment as pairs: its own, or this process's where it carries none,
 * which is what the child then inherits. */
function pairsOf(options) {
  if (Array.isArray(options.envPairs)) return options.envPairs.map(String);
  return Object.entries(process.env).map(([k, v]) => `${k}=${v}`);
}

/** Whether a normalized spawn is esbuild's service, which vite starts once and keeps. */
function isEsbuildService(options) {
  const args = Array.isArray(options.args) ? options.args.map(String) : [];
  return (
    /\/node_modules\/.*esbuild$/.test(String(options.file)) &&
    args.length === 3 &&
    /^--service=[\d.]+$/.test(args[1]) &&
    args[2] === '--ping'
  );
}

/** The first startup module a worker's arguments name that the vitest worker was not itself
 * started with, or null: one of its own runs before the watch as it did there, and the preload is
 * the watch, which a worker started inside a watched one inherits; any other runs unseen. */
function foreignStartup(execArgv, base) {
  const own = new Set((base?.execArgv ?? []).map((t) => startupModuleKey(t, null)));
  own.add(startupModuleKey(PRELOAD, null));
  const args = execArgv.map(String);
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].includes('=') ? args[i].split(/=(.*)/s) : [args[i], undefined];
    if (!WORKER_STARTUP.has(flag)) continue;
    const mod = inline ?? args[++i];
    if (mod === undefined || !own.has(startupModuleKey(mod, process.cwd()))) return mod ?? flag;
  }
  return null;
}

/** A worker's execArgv without the preload it inherited from a watched parent, which the watch
 * puts first again: each `--import` of it, inline or as the next word, is dropped. */
function withoutOwnPreload(execArgv) {
  const isOwn = (mod) =>
    mod !== undefined && startupModuleKey(mod, process.cwd()) === startupModuleKey(PRELOAD, null);
  const args = execArgv.map(String);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].includes('=') ? args[i].split(/=(.*)/s) : [args[i], undefined];
    if (flag === '--import' && inline === undefined && isOwn(args[i + 1])) i++;
    else if (!(flag === '--import' && isOwn(inline))) out.push(args[i]);
  }
  return out;
}

/** The raw bindings that list a directory or start a process without passing a watched call. */
const RAW_BINDINGS = new Map([
  ['fs', 'node:fs'],
  ['fs_dir', 'node:fs'],
  ['spawn_sync', 'a synchronous spawn'],
  ['process_wrap', 'an asynchronous spawn'],
]);

/** The spawn options a direct `ChildProcess` carries that the grammar rules on: only a set `uid` or
 * `gid`. `argv0` reaches the reader as `args[0]`, and the rest of the normalized options change no
 * execution. */
function readOpts(options) {
  const out = {};
  for (const k of ['uid', 'gid'])
    if (options[k] !== undefined && options[k] !== null) out[k] = options[k];
  return out;
}
