// The whole-tree guard's own log directories: each vitest worker's goes when the worker ends, and
// one a killed worker left is reaped by its name on the next run (ISS-1315, brought to dev by
// ISS-1059). A directory per worker that nothing removed piled up to 598,704 on one box.
// @direct-test-of scripts/lib/whole-tree-guard.mjs
// @direct-test-of scripts/lib/whole-tree-child.mjs

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  GUARD_DIRS,
  guardDirOwner,
  LEGACY_GUARD_DIR_AGE_MS,
  reapGuardDirs,
  reapLegacyGuardDirs,
} from './whole-tree-gates.mjs';

describe('guardDirOwner', () => {
  it('reads the process off a directory the guard made', () => {
    expect(guardDirOwner('4321-aB3dEf')).toBe(4321);
  });
  it('answers null for a name that carries no process, which no guard made', () => {
    for (const name of ['whole-tree-guard-aB3dEf', '0-aB3dEf', '-aB3dEf', '4321', 'x4321-aB3dEf'])
      expect(guardDirOwner(name)).toBeNull();
  });
});

describe('reapGuardDirs', () => {
  const names = ['10-a', '20-b', 'stray', '30-c'];
  const run = (live) => {
    const removed = [];
    const reaped = reapGuardDirs('/tmp/g', (pid) => live.includes(pid), {
      list: () => names,
      remove: (path, opts) => removed.push([path, opts]),
    });
    return { reaped, removed };
  };

  it('removes every directory whose process is gone, by its path, and answers their names', () => {
    const { reaped, removed } = run([20]);
    expect(reaped).toEqual(['10-a', '30-c']);
    expect(removed).toEqual([
      ['/tmp/g/10-a', { recursive: true, force: true }],
      ['/tmp/g/30-c', { recursive: true, force: true }],
    ]);
  });

  it('leaves a directory whose process may still be running, and one that names no process', () => {
    expect(run([10, 20, 30]).reaped).toEqual([]);
  });
});

describe('reapLegacyGuardDirs', () => {
  const parent = mkdtempSync(join(tmpdir(), 'whole-tree-legacy-'));
  afterAll(() => rmSync(parent, { recursive: true, force: true }));
  const now = Date.now();
  /** A directory named `name`, last written `age` ms ago, holding a log written `logAge` ms ago. */
  const seed = (name, age, logAge) => {
    const dir = join(parent, name);
    mkdirSync(dir);
    if (logAge !== undefined) {
      writeFileSync(join(dir, 'children-1.jsonl'), '');
      utimesSync(join(dir, 'children-1.jsonl'), (now - logAge) / 1000, (now - logAge) / 1000);
    }
    utimesSync(dir, (now - age) / 1000, (now - age) / 1000);
  };
  const DAY = LEGACY_GUARD_DIR_AGE_MS;

  it('removes an old-style directory nothing has written to for a day, and leaves every other', () => {
    seed('whole-tree-guard-Old2dA', 2 * DAY, 2 * DAY);
    seed('whole-tree-guard-NewHrA', 60 * 60 * 1000);
    seed('whole-tree-guard-LogNow', 2 * DAY, 60 * 1000);
    seed('whole-tree-guardian-2d', 2 * DAY);
    seed('4321-aB3dEf', 2 * DAY);
    expect(reapLegacyGuardDirs(parent, { now })).toEqual(['whole-tree-guard-Old2dA']);
    expect(existsSync(join(parent, 'whole-tree-guard-Old2dA'))).toBe(false);
    for (const kept of [
      'whole-tree-guard-NewHrA',
      'whole-tree-guard-LogNow',
      'whole-tree-guardian-2d',
      '4321-aB3dEf',
    ])
      expect(existsSync(join(parent, kept)), `${kept} was removed`).toBe(true);
  });
});

describe('the directories a run of the guard makes', () => {
  const REPO = resolve(import.meta.dirname, '..', '..');
  const parent = join(tmpdir(), GUARD_DIRS);
  const root = mkdtempSync(join(tmpdir(), 'whole-tree-dirs-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, 'vitest.config.mjs'),
    `export default { test: { globals: true, include: ['*.test.mjs'], setupFiles: [${JSON.stringify(join(REPO, 'scripts/lib/whole-tree-guard.mjs'))}] } };`,
  );
  // Each file writes down the directory its worker's guard made, then does what its name says.
  const file = (name, then = '') =>
    writeFileSync(
      join(root, `${name}.test.mjs`),
      [
        "import { appendFileSync } from 'node:fs';",
        `it('${name}', () => { appendFileSync(process.env.WT_DIRS, globalThis[Symbol.for('forge.whole-tree-guard')].dir + '\\n'); ${then} });`,
      ].join('\n'),
    );
  const vitest = (files, record) => {
    const r = spawnSync(
      process.execPath,
      [join(REPO, 'node_modules/vitest/vitest.mjs'), 'run', '--root', root, ...files],
      { cwd: root, encoding: 'utf8', env: { ...process.env, WT_DIRS: record, FORCE_COLOR: '0' } },
    );
    // the nested run is this file's child; what it listed was its own temporary root, not the repo
    writeFileSync(globalThis[Symbol.for('forge.whole-tree-guard')].log, '');
    return r;
  };
  const made = (record) => readFileSync(record, 'utf8').trim().split('\n').filter(Boolean);

  it('leaves none of them behind once the run is over', () => {
    for (const n of ['one', 'two', 'three']) file(n);
    const record = join(root, 'dirs-ended.txt');
    const r = vitest(['one', 'two', 'three'], record);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const dirs = made(record);
    expect(dirs).toHaveLength(3);
    for (const dir of dirs) {
      expect(existsSync(dir), `${dir} outlived the worker that made it`).toBe(false);
      expect(dirname(dir)).toBe(parent);
    }
  }, 60_000);

  it('reaps the directory of a worker that was killed, by its name, on the next run', () => {
    file('killed', "process.kill(process.pid, 'SIGKILL');");
    file('after');
    const killed = join(root, 'dirs-killed.txt');
    vitest(['killed'], killed);
    const [left] = made(killed);
    expect(existsSync(left), 'the killed worker could remove nothing').toBe(true);
    const r = vitest(['after'], join(root, 'dirs-after.txt'));
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(existsSync(left), `${left} was not reaped by the run after it`).toBe(false);
  }, 60_000);

  it('reaps an old-style directory a guard before ISS-1315 left two days ago, on the next run', () => {
    const old = join(tmpdir(), 'whole-tree-guard-I1059x');
    mkdirSync(old, { recursive: true });
    const twoDaysAgo = (Date.now() - 2 * LEGACY_GUARD_DIR_AGE_MS) / 1000;
    utimesSync(old, twoDaysAgo, twoDaysAgo);
    file('after');
    const r = vitest(['after'], join(root, 'dirs-legacy.txt'));
    const left = existsSync(old);
    rmSync(old, { recursive: true, force: true });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(left, `${old}, two days old, survived the run`).toBe(false);
  }, 60_000);
});
