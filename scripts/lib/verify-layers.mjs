import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_PATH, parseConfig } from './verify-window/config.mjs';
import { judgeEligibility, parseDiff } from './verify-window/eligibility.mjs';

/**
 * The gate's two layers, partitioned by what a check READS. `entry`: a verdict on each file from
 * that file alone, which a developer run pays. `shared`: a sweep whose verdict depends on files or
 * branches the change never opened, which a verify window pays once for a set.
 */
export const LAYERS = ['entry', 'shared'];

export const MODES = {
  whole: 'every check, each over the whole tree',
  entry: "the entry layer: this change's own files, scoped where the checker can scope",
  window: "the shared layer's sweeps, plus the entry layer over the combination's diff",
};

/** Every check that carries no layer or no reason for it, as the sentence that refuses it. */
export function unlayered(checks) {
  return checks
    .filter((c) => !LAYERS.includes(c.layer) || typeof c.reads !== 'string' || c.reads.length < 12)
    .map((c) => `${c.label}: layer \`${c.layer}\` and a \`reads\` saying what it reads`);
}

/** The checks a mode runs; an entry check runs its `scoped` form wherever it judges a change. */
export function checksFor(mode, checks) {
  const scoped = (c) => (c.scoped ? { ...c, ...c.scoped, scoped: undefined } : c);
  if (mode === 'whole') return checks;
  if (mode === 'entry') return checks.filter((c) => c.layer === 'entry').map(scoped);
  if (mode === 'window') return checks.map((c) => (c.layer === 'entry' ? scoped(c) : c));
  throw new Error(`no such verify mode: ${mode}`);
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  return r.status === 0 ? r.stdout : null;
}

/**
 * Whether the change from `base` to the working tree may take the entry layer alone, judged by the
 * declarations at `base` that a window admits members by.
 * @returns {{ eligible: true } | { eligible: false, surfaces: string[] } | { refusal: string }}
 */
export function entryEligibility(root, base) {
  const text = git(root, ['show', `${base}:${CONFIG_PATH}`]);
  const read = parseConfig(text, `${CONFIG_PATH} at ${base}`);
  if (read.refusal) return { refusal: read.refusal };
  const diff = git(root, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--unified=0',
    '--no-renames',
    '--no-color',
    base,
  ]);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (diff === null || untracked === null) {
    return { refusal: 'git could not read this change, so its eligibility cannot be judged' };
  }
  const files = parseDiff(diff);
  for (const path of untracked.split('\0').filter(Boolean)) {
    const lines = readFileSync(join(root, path), 'utf8').split('\n');
    files.push({ path, added: lines.map((text, i) => ({ line: i + 1, text })) });
  }
  const surfaces = judgeEligibility({ issue: 'this change', files }, read.config).map(
    (r) => r.message,
  );
  return surfaces.length === 0 ? { eligible: true } : { eligible: false, surfaces };
}
