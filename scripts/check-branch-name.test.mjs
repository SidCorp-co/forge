// @gate-input whole-tree — it runs a shell script, which the root-walk guard cannot see into.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const CHECKER = resolve(dirname(fileURLToPath(import.meta.url)), 'check-branch-name.sh');

const made = [];
afterEach(() => {
  while (made.length > 0) rmSync(made.pop(), { recursive: true, force: true });
});

const SEALED_ENV = { PATH: process.env.PATH ?? '', LC_ALL: 'C' };

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: SEALED_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A clone whose remote's recorded default is `trunk` — a base branch called none of the three. */
function checkout() {
  const box = mkdtempSync(join(tmpdir(), 'branch-name-'));
  made.push(box);
  const origin = join(box, 'origin.git');
  git(box, 'init', '--bare', '--initial-branch=trunk', origin);
  const seed = join(box, 'seed');
  git(box, 'clone', origin, seed);
  git(seed, 'config', 'user.email', 'check@example.invalid');
  git(seed, 'config', 'user.name', 'check');
  writeFileSync(join(seed, 'f.txt'), 'seed');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'push', 'origin', 'trunk');
  const work = join(box, 'work');
  git(box, 'clone', '-b', 'trunk', origin, work);
  return work;
}

function run(cwd, branch, extra = {}) {
  const r = spawnSync('bash', [CHECKER, branch], {
    cwd,
    encoding: 'utf8',
    env: { ...SEALED_ENV, ...extra },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('check-branch-name exempts the branch the work lands on', () => {
  it('accepts a base branch that is none of the three literal names', () => {
    expect(run(checkout(), 'trunk').code).toBe(0);
  });

  it('accepts the base ref of the pull request being built', () => {
    expect(run(checkout(), 'dev', { GITHUB_BASE_REF: 'dev' }).code).toBe(0);
  });

  it('still refuses a branch that is neither the base nor a declared scheme', () => {
    const got = run(checkout(), 'dev');
    expect(got.code).toBe(1);
    expect(got.out).toContain('does not match any accepted pattern');
    expect(got.out).toContain("reads that as 'trunk'");
  });

  it('keeps main and master exempt wherever the base points', () => {
    const work = checkout();
    expect(run(work, 'main').code).toBe(0);
    expect(run(work, 'master').code).toBe(0);
  });

  it('still accepts the pipeline scheme and refuses a malformed name', () => {
    const work = checkout();
    expect(run(work, 'ISS-1304-base-branch').code).toBe(0);
    expect(run(work, 'ISS-1304-1305-two-issues').code).toBe(1);
  });
});
