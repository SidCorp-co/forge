// Where a local run measures from (ISS-304's extra fix, forge-dev 2026-10-31): the base this
// repository declares in .forge/landing.json, never `origin/HEAD`. GitHub's default for
// SidCorp-co/forge is `main`, the gated production branch, while work lands on `dev`; a checkout
// whose origin/HEAD was refreshed to match the remote measured every local gate against `main`.
// Over a local bare remote whose default is `main` and which also carries `dev`.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const declare = (text) => {
  mkdirSync(join(clone, '.forge'), { recursive: true });
  writeFileSync(join(clone, '.forge', 'landing.json'), text);
};
const undeclare = () => rmSync(join(clone, '.forge'), { recursive: true, force: true });

describe('the merge target is the declared base, never the remote default', () => {
  it('measures from the declared base while origin/HEAD names main and nothing else is set', () => {
    git(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    declare('{ "base": "dev" }\n');
    expect(baseRef(clone, {})).toMatchObject({
      branch: 'dev',
      source: '.forge/landing.json',
      ref: 'origin/dev',
    });
  });

  it('a pull request base is read before the declaration, so a pull into main measures main', () => {
    declare('{ "base": "dev" }\n');
    expect(mergeTarget(clone, { GITHUB_BASE_REF: 'main' })).toEqual({
      branch: 'main',
      source: 'GITHUB_BASE_REF',
    });
  });

  it('with no declaration, refuses by name rather than reading origin/HEAD', () => {
    undeclare();
    git(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    const t = mergeTarget(clone, {});
    expect(t.branch).toBeUndefined();
    expect(t.summary).toContain('no merge target could be derived');
    expect(t.refusal).toContain('`GITHUB_BASE_REF=<branch>`');
    expect(t.refusal).toContain('.forge/landing.json');
  });

  it('a declaration present and malformed is refused naming the file, never read past', () => {
    for (const bad of ['{ "base": 42 }', '{}', 'base: dev', '{ "base": "--upload-pack=x" }']) {
      declare(bad);
      const t = mergeTarget(clone, {});
      expect(t.branch, bad).toBeUndefined();
      expect(t.summary).toBe('.forge/landing.json declares no branch work lands on');
      expect(t.refusal).toContain('{ "base": "<branch>" }');
    }
    undeclare();
  });
});
