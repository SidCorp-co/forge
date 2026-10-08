// What `verify` keeps between runs: a check's verdict, filed under the content of every file the
// check reads. Same bytes in, the stored verdict out; any other bytes, a real run. Never the git
// sha and never the diff as the key — a sha misses a dirty tree and a diff guesses which files a
// verdict leans on. Only a verdict that passed is filed, and only after a traced run showed that
// every file it read was one the declaration named.

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles } from './verify-memo-git.mjs';
import { spawnFault } from './verify-memo-spawn.mjs';

/** Bumped whenever the shape of a key or of a stored entry changes, so an old store never answers. */
const SCHEMA = 2;
const OUT_CAP = 1 << 20;
/** Variables a check or its tools are known to read, whose values the key therefore holds. */
const ENV_READ = [
  'BIOME_CONFIG_PATH',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GITHUB_BASE_REF',
  'GITHUB_EVENT_NAME',
  'GITHUB_EVENT_PATH',
  'GITHUB_REF',
];
const DEFAULT_BUDGET_MB = 16;
export const TRACER = resolve(dirname(fileURLToPath(import.meta.url)), 'verify-memo-trace.cjs');

const sha = (data) => createHash('sha256').update(data).digest('hex');

/** The store's directory: an override, else the XDG cache home, else `~/.cache`. Never the checkout. */
export function storeDir(env = process.env) {
  if (env.VERIFY_MEMO_DIR) return resolve(env.VERIFY_MEMO_DIR);
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'forge-verify-memo');
}

/** The bytes the store may hold; past it the least recently used entries go. */
export function storeBudget(env = process.env) {
  const mb = Number(env.VERIFY_MEMO_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_BUDGET_MB) * 1024 * 1024;
}

/** Why the memo is not consulted at all, or null where it is. `--all` and CI both measure afresh. */
export function bypassReason(args, env = process.env) {
  if (args.includes('--all')) return '--all measures every check afresh';
  if (env.CI) return 'CI is the gate, so it measures every check itself';
  return null;
}

const entryFile = (dir, key) => join(dir, `${key}.json`);

/** Every entry file the store holds, least recently used first; `parse` also reads each one. */
export function listEntries(dir, { parse = false } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^[0-9a-f]{64}\.json$/.test(f))
    .map((f) => {
      const file = join(dir, f);
      const st = statSync(file);
      return {
        file,
        key: f.slice(0, -5),
        bytes: st.size,
        usedAt: st.mtimeMs,
        entry: parse ? read(file) : null,
      };
    })
    .sort((a, b) => a.usedAt - b.usedAt);
}

function read(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Forgets entries, oldest use first, until what is left fits `budget`. */
export function evict(dir, budget) {
  const entries = listEntries(dir);
  let total = entries.reduce((n, e) => n + e.bytes, 0);
  for (const e of entries) {
    if (total <= budget) break;
    rmSync(e.file, { force: true });
    total -= e.bytes;
  }
}

/** The entry filed under `key`, marked as just used; null where there is none, or it is not ours. */
export function lookup(dir, key) {
  const file = entryFile(dir, key);
  let entry;
  try {
    entry = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (entry?.schema !== SCHEMA || entry.key !== key || entry.status !== 0) return null;
  try {
    const now = new Date();
    utimesSync(file, now, now);
  } catch {
    // Another worktree evicted it between the read and the touch: the verdict still stands.
  }
  return entry;
}

/** Files a passed verdict under `key`, atomically, and trims the store to its budget. */
export function store(dir, key, entry, budget) {
  if (entry.out.length > OUT_CAP) return { refused: `its output is over ${OUT_CAP} bytes` };
  mkdirSync(dir, { recursive: true });
  const file = entryFile(dir, key);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...entry, schema: SCHEMA, key, status: 0 }));
  renameSync(tmp, file);
  evict(dir, budget);
  return { stored: true };
}

/** A link as the bytes it leads to: where it points, and the content there. */
function linkBody(abs) {
  let target = 'dangling';
  try {
    target = statSync(abs).isFile() ? sha(readFileSync(abs)) : 'not a file';
  } catch {
    // Stays dangling: the link's own text still moves the key.
  }
  return `link:${readlinkSync(abs)}:${target}`;
}

/** The checkout as a check sees it: tracked and untracked-unignored files, hashed by content. */
export class Tree {
  constructor(root) {
    this.root = root;
    this.hashes = new Map();
    this.listing = null;
  }

  load() {
    if (this.listing) return this.listing;
    const { tracked, untracked } = listFiles(this.root);
    const alive = (f) => existsSync(join(this.root, f));
    this.listing = { tracked: new Set(tracked.filter(alive)), all: [] };
    this.listing.all = [...this.listing.tracked, ...untracked.filter(alive)].sort();
    return this.listing;
  }

  files() {
    return this.load().all;
  }

  isTracked(rel) {
    return this.load().tracked.has(rel);
  }

  /** The content hash of `rel`, re-read only where its size, mtime, inode or mode moved. */
  hash(rel) {
    const abs = join(this.root, rel);
    const st = lstatSync(abs, { bigint: true });
    const sig = `${st.size}:${st.mtimeNs}:${st.ino}:${st.mode}`;
    const seen = this.hashes.get(rel);
    if (seen?.sig === sig && !st.isSymbolicLink()) return seen.hash;
    const body = st.isSymbolicLink() ? linkBody(abs) : readFileSync(abs);
    const hash = `${st.mode & 0o111n ? 'x' : '-'}${sha(body)}`;
    this.hashes.set(rel, { sig, hash });
    return hash;
  }

  /** Forgets the file list, so the next question reads the checkout as it is now. */
  refresh() {
    this.listing = null;
  }
}

const rootPath = (r) => (typeof r === 'string' ? r : r.path);
const covers = (root, rel) => root === '.' || rel === root || rel.startsWith(`${root}/`);
const inRoot = (r, rel) => covers(rootPath(r), rel) && !(typeof r !== 'string' && r.skip.test(rel));

/** The files a declaration's roots name. */
export function coveredFiles(tree, roots) {
  return tree.files().filter((rel) => roots.some((r) => inRoot(r, rel)));
}

/** Files git ignores but a check still reads — a build's output, a directory of it or one file — listed from disk. */
export function builtFiles(root, dirs = []) {
  const out = [];
  for (const d of dirs) {
    const st = lstatOrNull(join(root, d));
    if (!st) continue;
    if (!st.isDirectory()) {
      if (st.isFile() || st.isSymbolicLink()) out.push(d);
      continue;
    }
    for (const name of readdirSync(join(root, d), { recursive: true })) {
      const rel = `${d}/${String(name).split('\\').join('/')}`;
      if (lstatSync(join(root, rel)).isFile()) out.push(rel);
    }
  }
  return out.sort();
}

/** How `abs` answers a stat: its kind and size, and for a link where it points and what is there. */
function statLine(abs) {
  const own = lstatOrNull(abs);
  if (!own) return null;
  const said = (st) => (st.isDirectory() ? 'dir' : `file:${st.size}`);
  if (!own.isSymbolicLink()) return said(own);
  let target = 'dangling';
  try {
    target = said(statSync(abs));
  } catch {
    // A link that leads nowhere is still a fact a stat reports.
  }
  return `link:${readlinkSync(abs)}:${target}`;
}

/**
 * What a check that only stats `paths` can learn from them: what is there, of what kind, how big a
 * file is and, through a link, what it leads to. Never what is inside, and never when it was
 * written, which would move on every build.
 */
export function probedState(root, paths = []) {
  const state = [];
  const note = (rel) => {
    const line = statLine(join(root, rel));
    if (line) state.push(`${rel}\0${line}`);
    return line;
  };
  for (const p of paths) {
    const line = note(p);
    if (!(line === 'dir' || line?.endsWith(':dir'))) continue;
    for (const name of readdirSync(join(root, p), { recursive: true })) {
      note(`${p}/${String(name).split('\\').join('/')}`);
    }
  }
  return state.sort();
}

function lstatOrNull(abs) {
  try {
    return lstatSync(abs);
  } catch {
    return null;
  }
}

/** Every directory above a root, so a name appearing beside what a check reads moves its key. */
function ancestors(roots) {
  const dirs = new Set();
  for (const r of roots.map(rootPath).filter((p) => p !== '.')) {
    const parts = r.split('/');
    for (let i = 0; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/') || '.');
  }
  return [...dirs].sort();
}

function shape(tree, roots) {
  return ancestors(roots).map((d) => {
    const prefix = d === '.' ? '' : `${d}/`;
    const names = tree
      .files()
      .filter((f) => f.startsWith(prefix))
      .map((f) => f.slice(prefix.length).split('/')[0]);
    return `${d}\0${[...new Set(names)].join('\0')}`;
  });
}

/**
 * The key a check's verdict is filed under, and how many files it was taken over. `git` is the
 * state a declaration with `git: true` also depends on: the head, and the base it is judged against.
 */
export function keyFor({ check, decl, tree, git, env = process.env }) {
  const files = coveredFiles(tree, decl.roots);
  const built = builtFiles(tree.root, decl.built);
  const lines = files.map((f) => `${f}\0${tree.hash(f)}\0${tree.isTracked(f) ? 'T' : 'U'}`);
  const named = tree.files().filter((f) => (decl.listed ?? []).some((d) => covers(d, f)));
  const body = {
    schema: SCHEMA,
    label: check.label,
    cmd: check.cmd,
    runtime: [process.version, process.platform, process.arch],
    files: sha(lines.join('\n')),
    built: sha(built.map((f) => `${f}\0${tree.hash(f)}`).join('\n')),
    listed: sha(named.join('\n')),
    probed: sha(probedState(tree.root, decl.probed).join('\n')),
    shape: sha(shape(tree, decl.roots).join('\n')),
    git: decl.git ? git : null,
    env: ENV_READ.map((k) => env[k] ?? null),
  };
  return { key: sha(JSON.stringify(body)), count: files.length + built.length };
}

/** The environment a traced run starts in, and the directory its trace files land in. */
export function traceEnv(env = process.env) {
  const dir = join(tmpdir(), `verify-memo-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const tracer = /\s/.test(TRACER) ? JSON.stringify(TRACER) : TRACER;
  const NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require=${tracer}`.trim();
  return { dir, env: { ...env, NODE_OPTIONS, VERIFY_MEMO_TRACE: join(dir, 'trace') } };
}

/** The lines every process of a traced run wrote; the directory they were in is removed. */
export function readTrace(dir) {
  const lines = [];
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    lines.push(...readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean));
  }
  rmSync(dir, { recursive: true, force: true });
  return lines;
}

const OUTSIDE = (rel) =>
  rel === '' ||
  rel.startsWith('..') ||
  rel === '.git' ||
  rel.startsWith('.git/') ||
  rel.split('/').includes('node_modules');

/** A probe of a glob pattern, which a tool tries as if it were a path and no file can answer. */
const GLOB = /[*!{}]/;

function stats(root, rel) {
  try {
    return statSync(join(root, rel));
  } catch {
    return null;
  }
}

/**
 * Every way a traced run read past its declaration: a file outside the roots, a directory listed
 * that they do not reach, a program asking git what the key does not hold. Empty where it held.
 */
export function audit({ root, decl, tree, lines, git }) {
  const reachable = new Set([...coveredFiles(tree, decl.roots), ...builtFiles(root, decl.built)]);
  const derived = new Set(decl.derived ?? []);
  const rootDirs = [...decl.roots.map(rootPath), ...(decl.built ?? []), ...(decl.listed ?? [])];
  const under = (rel) => rootDirs.some((r) => covers(r, rel));
  const above = (rel) => rel === '.' || rootDirs.some((r) => r.startsWith(`${rel}/`));
  const probed = (rel) => (decl.probed ?? []).some((p) => covers(p, rel));
  const faults = new Set();
  for (const line of lines) {
    const body = line.slice(2);
    if (line[0] === 'S') {
      const fault = spawnFault(JSON.parse(body), decl, git);
      if (fault) faults.add(fault);
      continue;
    }
    const rel = relative(root, body);
    if (OUTSIDE(rel) || GLOB.test(rel) || reachable.has(rel) || derived.has(rel)) continue;
    if ('PM'.includes(line[0]) && probed(rel)) continue;
    const st = stats(root, rel);
    if (line[0] === 'L' || st?.isDirectory()) {
      if (!(under(rel) || above(rel))) faults.add(`listed ${rel}/`);
    } else if (!st) {
      if (!(under(rel) || above(dirname(rel) === '.' ? '.' : dirname(rel))))
        faults.add(`probed ${rel}`);
    } else {
      faults.add(`${line[0] === 'P' ? 'stat' : 'read'} ${rel}`);
    }
  }
  return [...faults].sort();
}
