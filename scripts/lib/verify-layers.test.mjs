import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checksFor, entryEligibility, unlayered } from './verify-layers.mjs';

const CHECKS = [
  { label: 'per-file', layer: 'entry', reads: 'each file alone, judged file by file', cmd: ['a'] },
  {
    label: 'budget',
    layer: 'entry',
    reads: "each file's findings against its own baseline",
    cmd: ['b', '--all'],
    scoped: { cmd: ['b', '--changed'], scopeMayBeEmpty: true },
  },
  { label: 'sweep', layer: 'shared', reads: 'the whole import graph, every file', cmd: ['c'] },
];

describe('checksFor', () => {
  it('runs every check whole by default, as pnpm verify always has', () => {
    expect(checksFor('whole', CHECKS).map((c) => c.cmd.join(' '))).toEqual(['a', 'b --all', 'c']);
  });

  it('runs only the entry layer for a developer run, each scoped where it can be', () => {
    const entry = checksFor('entry', CHECKS);
    expect(entry.map((c) => c.cmd.join(' '))).toEqual(['a', 'b --changed']);
    expect(entry[1].scopeMayBeEmpty).toBe(true);
    expect(entry.some((c) => c.layer === 'shared')).toBe(false);
  });

  it('runs the sweeps once for a window, and the entry layer over its diff', () => {
    expect(checksFor('window', CHECKS).map((c) => c.cmd.join(' '))).toEqual([
      'a',
      'b --changed',
      'c',
    ]);
  });

  it('refuses a mode it does not know', () => {
    expect(() => checksFor('fast', CHECKS)).toThrow('no such verify mode: fast');
  });
});

describe('unlayered', () => {
  it('names a check with no layer, an unknown one, or no reason for it', () => {
    expect(
      unlayered([
        ...CHECKS,
        { label: 'bare', cmd: ['x'] },
        { label: 'odd', layer: 'both', reads: 'something long enough', cmd: ['y'] },
        { label: 'terse', layer: 'entry', reads: 'files', cmd: ['z'] },
      ]),
    ).toEqual([
      'bare: layer `undefined` and a `reads` saying what it reads',
      'odd: layer `both` and a `reads` saying what it reads',
      'terse: layer `entry` and a `reads` saying what it reads',
    ]);
  });
});

const box = mkdtempSync(join(tmpdir(), 'verify-layers-'));
afterAll(() => rmSync(box, { recursive: true, force: true }));

const ENV = { PATH: process.env.PATH ?? '', HOME: box, LC_ALL: 'C' };
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function put(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

const DECLARATIONS = JSON.stringify({
  check: 'ci-passed',
  migrations: { dir: 'db' },
  gate: { prepare: [], run: ['node', 'gate.mjs'] },
  ineligible: {
    paths: [{ glob: 'runner/**', reason: 'runs on three platforms' }],
    linesIn: ['**/*.mjs'],
    lines: [{ pattern: 'process\\.env\\.PATH\\b', reason: 'PATH is read by every child process' }],
  },
});

/** A repository whose base commit declares the rules, and a change on top of it. */
function repo(name, change, declarations = DECLARATIONS) {
  const dir = join(box, name);
  mkdirSync(dir);
  git(dir, 'init', '-q', '--initial-branch=main');
  git(dir, 'config', 'user.email', 'l@example.invalid');
  git(dir, 'config', 'user.name', 'layers');
  put(dir, { 'src/a.mjs': 'export const a = 1;\n' });
  if (declarations !== null) put(dir, { '.forge/verify-queue.json': declarations });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  put(dir, change);
  return { dir, base };
}

describe('entryEligibility', () => {
  it('lets a change touching no declared surface take the entry layer', () => {
    const { dir, base } = repo('eligible', { 'src/a.mjs': 'export const a = 2;\n' });
    expect(entryEligibility(dir, base)).toEqual({ eligible: true });
  });

  it('sends a change touching a declared path to the whole gate, naming the path and why', () => {
    const { dir, base } = repo('by-path', { 'runner/main.rs': 'fn main() {}\n' });
    expect(entryEligibility(dir, base)).toEqual({
      eligible: false,
      surfaces: [
        'this change touches runner/main.rs, which `runner/**` declares ineligible: runs on three platforms',
      ],
    });
  });

  it('reads an untracked symlink as the path it names, and never throws on one to a directory', () => {
    const { dir, base } = repo('untracked-link', {});
    mkdirSync(join(dir, 'elsewhere'));
    put(dir, { '.gitignore': 'elsewhere/\n' });
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'src/linked'));
    expect(entryEligibility(dir, base)).toEqual({ eligible: true });
  });

  it('reads an untracked file as added, so a new file cannot slip past the line rules', () => {
    const { dir, base } = repo('untracked', { 'src/env.mjs': "process.env.PATH = '/x';\n" });
    expect(entryEligibility(dir, base).surfaces).toEqual([
      "this change adds src/env.mjs:1 `process.env.PATH = '/x';`, which matches `process\\.env\\.PATH\\b`: PATH is read by every child process",
    ]);
  });

  it('judges by the declarations at the base, so a change cannot loosen its own rule', () => {
    const loosened = DECLARATIONS.replace('runner/**', 'nothing/**');
    const { dir, base } = repo('loosened', {
      '.forge/verify-queue.json': loosened,
      'runner/main.rs': 'fn main() {}\n',
    });
    expect(entryEligibility(dir, base).eligible).toBe(false);
  });

  it('refuses by name where the base declares nothing, rather than reading it as eligible', () => {
    const { dir, base } = repo('undeclared', { 'src/a.mjs': 'export const a = 3;\n' }, null);
    expect(entryEligibility(dir, base).refusal).toMatch(
      /^\.forge\/verify-queue\.json at [0-9a-f]{40}: there is no such file/,
    );
  });
});
