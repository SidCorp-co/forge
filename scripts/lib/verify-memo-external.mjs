// What a traced run read outside the checkout, held beside its filing and checked before the entry
// is served again: the user's config, and the project files and probes in directories above it.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const BIG = 256 * 1024;
const SYSTEM = ['/proc', '/sys', '/dev', '/usr', '/lib', '/lib64', '/bin', '/sbin', '/opt'];

function toolState(home, tmp) {
  const dirs = ['.npm', '.cache', '.local', '.nvm'].map((d) => join(home, d));
  return [...SYSTEM, tmp, dirname(dirname(process.execPath)), ...dirs];
}

const under = (dir, path) => path === dir || path.startsWith(`${dir}/`);

function contentOf(path, size, mtimeMs) {
  if (size > BIG) return `big:${size}:${mtimeMs}`;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** A path as it reads now: its content, its absence, or null for what is no input (a directory). */
export function signatureOf(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return '-';
  }
  if (!st.isSymbolicLink()) return st.isFile() ? contentOf(path, st.size, st.mtimeMs) : null;
  try {
    const target = statSync(path);
    return target.isFile()
      ? `link:${readlinkSync(path)}:${contentOf(path, target.size, target.mtimeMs)}`
      : null;
  } catch {
    return `link:${readlinkSync(path)}:dangling`;
  }
}

/** Whether a file was written after `since`, so a signature taken now is not what the run read. */
function writtenSince(path, since) {
  try {
    return statSync(path).isFile() && statSync(path).mtimeMs > since;
  } catch {
    return false;
  }
}

/**
 * The outside reads of a trace as `[path, signature]`; a fault for each outside listing; and the
 * paths that changed under the run: written after it began, deleted after a read found them, or
 * created after a probe found nothing.
 */
export function externalDeps({ root, lines, since = Infinity, home = homedir(), tmp = tmpdir() }) {
  const skipped = toolState(home, tmp);
  const seen = new Map();
  const faults = new Set();
  for (const line of lines.filter((l) => 'RPMQL'.includes(l[0]))) {
    const path = line.slice(2);
    const mirrored = path.toLowerCase().startsWith(`${root.toLowerCase()}/`);
    if (under(root, path) || mirrored || skipped.some((d) => under(d, path))) continue;
    if (line[0] === 'L') faults.add(`listed ${path}/, outside the checkout`);
    else seen.set(path, `${seen.get(path) ?? ''}${line[0]}`);
  }
  const deps = [];
  const moved = [];
  for (const [path, kinds] of seen) {
    const sig = signatureOf(path);
    if (sig !== null) deps.push([path, sig]);
    const found = kinds.includes('R') || kinds.includes('P');
    const missing = kinds.includes('M');
    if (
      (found && sig === '-') ||
      (missing && sig !== '-' && sig !== null) ||
      writtenSince(path, since)
    ) {
      moved.push(path);
    }
  }
  return { deps: deps.sort(), faults: [...faults].sort(), moved: moved.sort() };
}

/** Whether every outside read an entry recorded still reads as it did. */
export function externalHolds(deps = []) {
  return deps.every(([path, sig]) => signatureOf(path) === sig);
}
