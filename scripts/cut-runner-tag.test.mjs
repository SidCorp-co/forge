// @gate-input whole-tree — it runs git in a fixture repository, which the guard counts as the root
// @direct-test-of scripts/cut-runner-tag.mjs
//
// ISS-1358: a commit is refused when its OWN line already released it, never because the other line
// did. Dev and main share commits once dev is merged into main, and main's autorelease refusing a
// commit dev's prerelease carries would leave main's line unreleased.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cutRunnerTag, releasesAt } from './cut-runner-tag.mjs';

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

let root;
let work;
let commit;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cut-runner-tag-'));
  const remote = join(root, 'remote.git');
  work = join(root, 'work');
  git(root, 'init', '-q', '--bare', remote);
  git(root, 'init', '-q', work);
  writeFileSync(join(work, 'a'), 'a\n');
  git(work, 'add', 'a');
  git(work, 'commit', '-q', '-m', 'a');
  git(work, 'remote', 'add', 'origin', remote);
  commit = git(work, 'rev-parse', 'HEAD');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a release is refused only by its own line', () => {
  it('main cuts a commit dev already released, and dev then refuses a second dev tag there', () => {
    cutRunnerTag({ cwd: work, tag: 'runner-v0.18.0-dev.1', commit });
    expect(releasesAt(work, commit, 'runner-v0.18.0')).toEqual([]);
    expect(cutRunnerTag({ cwd: work, tag: 'runner-v0.18.0', commit })).toEqual({
      tag: 'runner-v0.18.0',
      commit,
    });
    expect(() => cutRunnerTag({ cwd: work, tag: 'runner-v0.18.0-dev.2', commit })).toThrow(
      /already released as runner-v0\.18\.0-dev\.1/,
    );
    expect(() => cutRunnerTag({ cwd: work, tag: 'runner-v0.18.1', commit })).toThrow(
      /already released as runner-v0\.18\.0 /,
    );
  });
});
