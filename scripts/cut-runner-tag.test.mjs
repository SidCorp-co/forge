// @gate-input whole-tree — it runs git in a fixture repository, which the guard counts as the root
// @direct-test-of scripts/cut-runner-tag.mjs
//
// ISS-1358: a commit is refused when its OWN line already released it, never because the other line
// did. Dev and main share commits once dev is merged into main, and main's autorelease refusing a
// commit dev's prerelease carries would leave main's line unreleased.
//
// ISS-1373: and only by a tag whose GitHub Release is published. A tag is cut before its build, so
// one whose build failed stands with no release; the next run builds under that same tag.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
let failed;
let shared;

const commitFile = (name) => {
  writeFileSync(join(work, name), `${name}\n`);
  git(work, 'add', name);
  git(work, 'commit', '-q', '-m', name);
  return git(work, 'rev-parse', 'HEAD');
};
const remoteTags = () => git(work, 'ls-remote', '--tags', 'origin');

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
  failed = commitFile('b');
  shared = commitFile('c');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a release is refused only by its own line', () => {
  it('main cuts a commit dev already released, and dev then refuses a second dev tag there', () => {
    const published = ['runner-v0.18.0-dev.1', 'runner-v0.18.0'];
    cutRunnerTag({ cwd: work, tag: 'runner-v0.18.0-dev.1', commit, published });
    expect(releasesAt(work, commit, 'runner-v0.18.0', published)).toEqual([]);
    expect(cutRunnerTag({ cwd: work, tag: 'runner-v0.18.0', commit, published })).toEqual({
      tag: 'runner-v0.18.0',
      commit,
      reused: false,
    });
    expect(() =>
      cutRunnerTag({ cwd: work, tag: 'runner-v0.18.0-dev.2', commit, published }),
    ).toThrow(/already released as runner-v0\.18\.0-dev\.1/);
    expect(() => cutRunnerTag({ cwd: work, tag: 'runner-v0.18.1', commit, published })).toThrow(
      /already released as runner-v0\.18\.0 /,
    );
  });
});

describe('a tag whose build never published is not a release', () => {
  it('is reused at its own commit, pushing and moving nothing', () => {
    cutRunnerTag({ cwd: work, tag: 'runner-v0.18.0-dev.5', commit: failed, published: [] });
    const before = remoteTags();
    expect(
      cutRunnerTag({ cwd: work, tag: 'runner-v0.18.0-dev.5', commit: failed, published: [] }),
    ).toEqual({ tag: 'runner-v0.18.0-dev.5', commit: failed, reused: true });
    expect(remoteTags()).toBe(before);
  });

  it('is never stepped over by a new version at the same commit', () => {
    expect(() =>
      cutRunnerTag({ cwd: work, tag: 'runner-v0.18.0-dev.6', commit: failed, published: [] }),
    ).toThrow(/carries runner-v0\.18\.0-dev\.5 with no published release/);
    expect(git(work, 'tag', '--list', 'runner-v0.18.0-dev.6')).toBe('');
  });

  it('is still refused once its release is published', () => {
    const published = ['runner-v0.18.0-dev.5'];
    for (const tag of ['runner-v0.18.0-dev.5', 'runner-v0.18.0-dev.6']) {
      expect(() => cutRunnerTag({ cwd: work, tag, commit: failed, published })).toThrow(
        /already released as runner-v0\.18\.0-dev\.5/,
      );
    }
  });

  it('a tag at another commit is still never moved, published or not', () => {
    expect(() =>
      cutRunnerTag({ cwd: work, tag: 'runner-v0.18.0-dev.5', commit: shared, published: [] }),
    ).toThrow(/runner-v0\.18\.0-dev\.5 already exists at .* never moved/);
  });

  it("a dev tag is invisible to main's line, either way round", () => {
    cutRunnerTag({ cwd: work, tag: 'runner-v0.18.0-dev.7', commit: shared, published: [] });
    // dev's unpublished tag neither refuses main nor is taken up by it
    expect(
      cutRunnerTag({ cwd: work, tag: 'runner-v0.18.1', commit: shared, published: [] }),
    ).toEqual({ tag: 'runner-v0.18.1', commit: shared, reused: false });
    // dev's published release does not stop main reusing its own unpublished tag
    const published = ['runner-v0.18.0-dev.7'];
    expect(cutRunnerTag({ cwd: work, tag: 'runner-v0.18.1', commit: shared, published })).toEqual({
      tag: 'runner-v0.18.1',
      commit: shared,
      reused: true,
    });
    expect(releasesAt(work, shared, 'runner-v0.18.1', published)).toEqual([]);
    expect(releasesAt(work, shared, 'runner-v0.18.0-dev.8', published)).toEqual([
      'runner-v0.18.0-dev.7',
    ]);
  });

  it('refuses by name when the tags at the commit cannot be read, never reading none', () => {
    const missing = 'no-such-commit';
    expect(() => releasesAt(work, missing, 'runner-v0.18.9', [])).toThrow(
      /reading the runner tags at no-such-commit failed.*git tag --points-at: .*malformed object name/,
    );
    expect(() =>
      cutRunnerTag({ cwd: work, tag: 'runner-v0.18.9', commit: missing, published: [] }),
    ).toThrow(/reading the runner tags .* failed/);
    expect(git(work, 'tag', '--list', 'runner-v0.18.9')).toBe('');
  });

  it('an autorelease over a released commit cuts nothing and ends green, an explicit cut still refused', () => {
    // a push changing only how the runner is built lands on a runner commit already released
    const published = ['runner-v0.18.0-dev.5'];
    const before = remoteTags();
    expect(
      cutRunnerTag({
        cwd: work,
        tag: 'runner-v0.18.0-dev.9',
        commit: failed,
        published,
        skipReleased: true,
      }),
    ).toEqual({
      tag: 'runner-v0.18.0-dev.9',
      commit: failed,
      reused: false,
      released: ['runner-v0.18.0-dev.5'],
    });
    expect(git(work, 'tag', '--list', 'runner-v0.18.0-dev.9')).toBe('');
    expect(remoteTags()).toBe(before);

    // the workflow's own call: exit 0, a notice, and no release owed
    const listed = join(root, 'published.txt');
    const output = join(root, 'github-output.txt');
    writeFileSync(listed, `${published.join('\n')}\n`);
    const cli = (...flags) =>
      spawnSync(
        process.execPath,
        [
          join(import.meta.dirname, 'cut-runner-tag.mjs'),
          ...flags,
          'runner-v0.18.0-dev.9',
          failed,
          '--published',
          listed,
          '--cwd',
          work,
          '--output',
          output,
        ],
        { encoding: 'utf8' },
      );
    const skipped = cli('--skip-released');
    expect(skipped.status, skipped.stderr).toBe(0);
    expect(skipped.stdout).toMatch(/^::notice::.* already released as runner-v0\.18\.0-dev\.5/);
    expect(readFileSync(output, 'utf8')).toBe('owed=false\n');
    const explicit = cli();
    expect(explicit.status).toBe(1);
    expect(explicit.stderr).toMatch(/already released as runner-v0\.18\.0-dev\.5/);
    expect(git(work, 'tag', '--list', 'runner-v0.18.0-dev.9')).toBe('');
  });

  it('refuses a cut that is not told which releases are published', () => {
    expect(() => cutRunnerTag({ cwd: work, tag: 'runner-v0.18.9', commit: shared })).toThrow(
      /published releases are required/,
    );
  });
});
