// Preloaded into every Node process a memoised check starts (`node --require`), so the files a
// check reads are a fact the memo can compare with what it declared. At exit the process writes
// `<VERIFY_MEMO_TRACE>.<pid>`, one line each: `R` a path whose content was read, `P` one only
// stat-ed (or otherwise probed for what the file system says of it) and found, `M` one found
// missing, `Q` one an async call asked for, `L` a listing, `S <json>` a program started. It
// reports; the verdict on it is verify-memo.mjs's.

'use strict';

const fs = require('node:fs');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { resolve } = require('node:path');
const { fileURLToPath } = require('node:url');
const { promisify } = require('node:util');

const { VERIFY_MEMO_TRACE: out } = process.env;

const READS = [
  'readFile',
  'readFileSync',
  'open',
  'openSync',
  'createReadStream',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'readlink',
  'readlinkSync',
  'realpath',
  'realpathSync',
];
/** Calls that learn whether a path is there and of what kind, and nothing a link or a file says. */
const PROBES = [
  'stat',
  'statSync',
  'lstat',
  'lstatSync',
  'access',
  'accessSync',
  'exists',
  'existsSync',
];
const LISTINGS = ['readdir', 'readdirSync', 'opendir', 'opendirSync'];
const SPAWNERS = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'];

/** The trace letter for a call's outcome: a read or probe that found nothing is `M`. */
function letter(kind, name, err, value) {
  const absent =
    err?.code === 'ENOENT' ||
    value === false ||
    (!err && value === undefined && /^l?stat(Sync)?$/.test(name));
  return (kind === 'R' || kind === 'P') && absent ? 'M' : kind;
}

function pathOf(arg) {
  if (typeof arg === 'string') return resolve(arg);
  if (Buffer.isBuffer(arg)) return resolve(arg.toString());
  if (arg instanceof URL && arg.protocol === 'file:') return fileURLToPath(arg);
  return null;
}

if (out) {
  const write = fs.writeFileSync;
  const noted = new Set();

  const watch = (host, name, kind) => {
    const original = host[name];
    if (typeof original !== 'function') return;
    const sync = name.endsWith('Sync');
    const watched = function watched(...args) {
      const at = pathOf(args[0]);
      if (at === null) return original.apply(this, args);
      const record = (err, value) => noted.add(`${letter(kind, name, err, value)} ${at}`);
      if (sync) {
        try {
          const result = original.apply(this, args);
          record(null, result);
          return result;
        } catch (err) {
          record(err);
          throw err;
        }
      }
      const last = args.length - 1;
      if (typeof args[last] === 'function') {
        const done = args[last];
        args[last] = function called(...got) {
          if (name === 'exists') record(null, got[0]);
          else record(got[0], got[1]);
          return done.apply(this, got);
        };
        return original.apply(this, args);
      }
      const result = original.apply(this, args);
      if (typeof result?.then === 'function') {
        return result.then(
          (value) => {
            record(null, value);
            return value;
          },
          (err) => {
            record(err);
            throw err;
          },
        );
      }
      noted.add(`${kind === 'R' || kind === 'P' ? 'Q' : kind} ${at}`);
      return result;
    };
    for (const key of Reflect.ownKeys(original)) {
      if (['length', 'name', 'prototype'].includes(key)) continue;
      Object.defineProperty(watched, key, Object.getOwnPropertyDescriptor(original, key));
    }
    host[name] = watched;
  };

  for (const host of [fs, fs.promises]) {
    for (const name of READS) watch(host, name, 'R');
    for (const name of PROBES) watch(host, name, 'P');
    for (const name of LISTINGS) watch(host, name, 'L');
  }

  const optionsAt = (name, args) =>
    name === 'exec' || name === 'execSync' ? 1 : Array.isArray(args[1]) ? 2 : 1;

  const arm = (name, args) => {
    const at = optionsAt(name, args);
    const next = [...args];
    if (typeof next[at] === 'function') next.splice(at, 0, {});
    else if (next[at] === undefined || next[at] === null) next[at] = {};
    else if (typeof next[at] !== 'object') return args;
    const env = { ...(next[at].env ?? process.env) };
    if (!(env.NODE_OPTIONS ?? '').includes(__filename)) {
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(__filename)}`.trim();
    }
    env.VERIFY_MEMO_TRACE = out;
    next[at] = { ...next[at], env };
    return next;
  };

  const spawning = (name, original) => {
    const watched = function watched(...args) {
      const next = arm(name, args);
      const argv = Array.isArray(next[1]) ? next[1].map(String) : [];
      const shell = next[optionsAt(name, next)]?.shell;
      noted.add(
        `S ${JSON.stringify(shell ? [[String(next[0]), ...argv].join(' ')] : [String(next[0]), ...argv])}`,
      );
      return original.apply(this, next);
    };
    for (const key of Reflect.ownKeys(original)) {
      if (['length', 'name', 'prototype', promisify.custom].includes(key)) continue;
      Object.defineProperty(watched, key, Object.getOwnPropertyDescriptor(original, key));
    }
    return watched;
  };

  for (const name of SPAWNERS) {
    const original = childProcess[name];
    childProcess[name] = spawning(name, original);
    const custom = original[promisify.custom];
    if (typeof custom === 'function') {
      Object.defineProperty(childProcess[name], promisify.custom, {
        value: spawning(name, custom),
      });
    }
  }
  syncBuiltinESMExports();

  process.on('exit', () => {
    write(`${out}.${process.pid}`, `${[...noted].join('\n')}\n`);
  });
}
