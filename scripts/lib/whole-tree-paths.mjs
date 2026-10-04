// Path and glob primitives the whole-tree guard's shell, git and node readers share.

import { lstatSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const MAGIC_SEGMENT = /[*?[\]{}()!+@]/;

/** The directory a glob pattern starts listing from: its segments before the first magic one. */
export function globBase(pattern) {
  const kept = [];
  for (const seg of pattern.split(/[\\/]/)) {
    if (MAGIC_SEGMENT.test(seg)) break;
    kept.push(seg);
  }
  const base = kept.join('/');
  if (base) return base;
  return pattern.startsWith('/') ? '/' : '.';
}

/**
 * Whether a glob climbs with a `..` after its first magic segment: the walk then ends wherever the
 * matches lead, which no reading of the prefix says, so such a pattern counts as the root.
 */
export function climbsAfterMagic(pattern) {
  let magic = false;
  for (const seg of pattern.split(/[\\/]/)) {
    if (magic && seg === '..') return true;
    if (MAGIC_SEGMENT.test(seg)) magic = true;
  }
  return false;
}

/**
 * Where the kernel resolves a path: the realpath of the path as written, its parent segments not
 * collapsed first, so a symlink's `..` and `/proc/self/cwd` land where a listing of them lands. A
 * path that does not exist keeps its lexical placement; one the kernel cannot resolve for any other
 * reason (a symlink loop, a directory it may not search) is `null`, which every caller counts as the
 * root.
 */
export function physical(path) {
  try {
    return realpathSync.native(path);
  } catch (e) {
    return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? resolve(path) : null;
  }
}

/**
 * Whether `dir` is `root` or inside it, decided on canonical paths: each side is read both as
 * written and by its realpath, and either reading inside counts. A directory that cannot be
 * canonicalized counts as inside, since nothing rules it out.
 */
export function withinRoot(root, dir) {
  const dirs = [dir, physical(dir)];
  if (dirs.includes(null)) return true;
  const roots = [...new Set([root, physical(root) ?? root])];
  return dirs.some((d) => roots.some((r) => d === r || d.startsWith(`${r}${sep}`)));
}

export const isWord = (w) => typeof w === 'string';

/** A listing entry: the directory listed and how, or a refusal counted as the root. */
export function at(dir, via) {
  return { dir, via };
}
export function root(via, r) {
  return { dir: r, via, unseen: true };
}

export const short = (s) => (s.length > 60 ? `…${s.slice(-59)}` : s);

/** Whether a path is a directory, following a symlink. `p` is already a realpath from `physical`. */
export function isDir(p) {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}
