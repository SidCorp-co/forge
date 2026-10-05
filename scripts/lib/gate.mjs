// What every gate script under scripts/ repeats: where the repository is, how a gate says it could
// not run, how it asks git, and how it walks a source tree.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Exit 2 is "could not run" for every gate — never a pass and never a finding. */
export const dieAs = (label) => (message) => {
  console.error(`${label}: ${message}`);
  process.exit(2);
};

/** git's stdout as text, or null when git exits non-zero. */
export function gitOut(args, cwd = ROOT) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** Blanks `//` and `/* *\/` comments, keeping every newline so line numbers still hold. */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Repo-relative paths under `rel` that `keep` admits, skipping `skipDirs` by name; [] when absent. */
export function walkFiles(rel, { skipDirs, keep }, acc = []) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return acc;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!skipDirs.includes(entry.name)) walkFiles(path, { skipDirs, keep }, acc);
    } else if (keep(path, entry.name)) acc.push(path);
  }
  return acc;
}

/** A repo-relative glob supporting `*` and `**`, anchored at both ends. */
export function globToRegExp(glob) {
  const body = glob
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((lit) => lit.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${body}$`);
}
