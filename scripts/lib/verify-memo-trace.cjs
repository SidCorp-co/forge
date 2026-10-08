// Preloaded into every Node process a memoised check starts (`node --require`), so the files a
// check actually reads are a fact the memo can compare with the inputs it declared, rather than a
// claim nobody re-reads. Each `node:fs` call that reads, lists or probes a path is noted, and each
// program the process starts. At exit the process writes `<VERIFY_MEMO_TRACE>.<pid>`, one line
// each: `R <path>` a read or probe, `L <path>` a listing, `S <json>` a program started. It reports;
// the verdict on it is verify-memo.mjs's.

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
  'stat',
  'statSync',
  'lstat',
  'lstatSync',
  'access',
  'accessSync',
  'exists',
  'existsSync',
  'readlink',
  'readlinkSync',
  'realpath',
  'realpathSync',
];
const LISTINGS = ['readdir', 'readdirSync', 'opendir', 'opendirSync'];
const SPAWNERS = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'];

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
    const watched = function watched(...args) {
      const at = pathOf(args[0]);
      if (at !== null) noted.add(`${kind} ${at}`);
      return original.apply(this, args);
    };
    for (const key of Reflect.ownKeys(original)) {
      if (['length', 'name', 'prototype'].includes(key)) continue;
      Object.defineProperty(watched, key, Object.getOwnPropertyDescriptor(original, key));
    }
    host[name] = watched;
  };

  for (const host of [fs, fs.promises]) {
    for (const name of READS) watch(host, name, 'R');
    for (const name of LISTINGS) watch(host, name, 'L');
  }

  const arm = (name, args) => {
    const at = name === 'exec' || name === 'execSync' ? 1 : Array.isArray(args[1]) ? 2 : 1;
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
      const argv = Array.isArray(args[1]) ? args[1] : [];
      noted.add(`S ${JSON.stringify([String(args[0]), ...argv.map(String)])}`);
      return original.apply(this, arm(name, args));
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
