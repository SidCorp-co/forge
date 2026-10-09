// What the merge target's refusals tell a reader to do (ISS-472 round 2): a stale or missing
// `origin/HEAD` names `GITHUB_BASE_REF=<branch>` for the branch the work lands on, and offers
// `git remote set-head` only for the remote's own default, since following that advice on dev work
// would measure it against `main`. Over a local bare remote, so the remote can be asked.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseRef, mergeTarget } from './base-branch.mjs';

let dir = '';
let clone = '';

const AUTHOR = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...AUTHOR } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'base-branch-'));
  const seed = join(dir, 'seed');
  const remote = join(dir, 'remote.git');
  git(dir, 'init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  git(seed, 'add', 'a.txt');
  git(seed, 'commit', '-q', '-m', 'a');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'push', '-q', remote, 'main', 'main:dev');
  clone = join(dir, 'clone');
  git(dir, 'clone', '-q', remote, clone);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a stale origin/HEAD names the base the record holds, not only the remote default', () => {
  it('refuses, offering GITHUB_BASE_REF for the recorded branch and set-head for the new default', () => {
    git(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/dev');
    const t = mergeTarget(clone, {});
    expect(t.summary).toBe(
      "refs/remotes/origin/HEAD records `dev` as the remote's default, and the remote now names `main`",
    );
    expect(t.refusal).toContain('GITHUB_BASE_REF=dev <command>   where it lands on `dev`');
    expect(t.refusal).toContain(
      "git remote set-head origin -a   where it lands on `main`, the remote's default now",
    );
    expect(t.refusal).not.toContain('Refresh it');
  });

  it('a named base is read first, so the advice it gives works', () => {
    expect(baseRef(clone, { GITHUB_BASE_REF: 'dev' })).toMatchObject({
      branch: 'dev',
      source: 'GITHUB_BASE_REF',
      ref: 'origin/dev',
    });
  });

  it('a record agreeing with the remote is the target', () => {
    git(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    expect(mergeTarget(clone, {})).toEqual({ branch: 'main', source: 'origin/HEAD' });
  });

  it('no record at all names GITHUB_BASE_REF before set-head', () => {
    git(clone, 'symbolic-ref', '-d', 'refs/remotes/origin/HEAD');
    const t = mergeTarget(clone, {});
    expect(t.refusal).toContain('`GITHUB_BASE_REF=<branch>`');
    expect(t.refusal.indexOf('GITHUB_BASE_REF=<branch>')).toBeLessThan(
      t.refusal.indexOf('git remote set-head origin -a'),
    );
  });
});
