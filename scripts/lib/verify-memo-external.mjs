// What a traced run read outside the checkout, held beside its filing and checked before the entry
// is served again: the user's config, and the project files and probes in directories above it.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const BIG = 256 * 1024;
const SYSTEM = ['/proc', '/sys', '/dev', '/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc', '/opt'];

function toolState(home, tmp) {
  const dirs = ['.npm', '.cache', '.local', '.nvm'].map((d) => join(home, d));
  return [...SYSTEM, tmp, dirname(dirname(process.execPath)), ...dirs];
}

const under = (dir, path) => path === dir || path.startsWith(`${dir}/`);

/** A path as it reads now: its content, its absence, or null for what is no input (a directory). */
export function signatureOf(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return '-';
  }
  if (!st.isFile()) return null;
  if (st.size > BIG) return `big:${st.size}:${st.mtimeMs}`;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The outside reads of a trace as `[path, signature]`, and a fault for each outside listing. */
export function externalDeps({ root, lines, home = homedir(), tmp = tmpdir() }) {
  const skipped = toolState(home, tmp);
  const deps = new Map();
  const faults = new Set();
  for (const line of lines.filter((l) => l[0] === 'R' || l[0] === 'L')) {
    const path = line.slice(2);
    const mirrored = path.toLowerCase().startsWith(`${root.toLowerCase()}/`);
    if (under(root, path) || mirrored || skipped.some((d) => under(d, path))) continue;
    if (line[0] === 'L') faults.add(`listed ${path}/, outside the checkout`);
    else if (!deps.has(path)) deps.set(path, signatureOf(path));
  }
  return { deps: [...deps].filter(([, sig]) => sig !== null).sort(), faults: [...faults].sort() };
}

/** Whether every outside read an entry recorded still reads as it did. */
export function externalHolds(deps = []) {
  return deps.every(([path, sig]) => signatureOf(path) === sig);
}
