import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cutRunnerTag, releasesAt, tagTarget } from './cut-runner-tag.mjs';

// A real repository with a real remote, because the subject of these assertions is
// what git does when a tag already exists — which a stub would simply agree with.
let dir;
let work;
let remote;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function commitFile(name, body) {
  writeFileSync(join(work, name), body);
  git(work, 'add', name);
  git(work, 'commit', '-m', name);
  return git(work, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cut-runner-tag-'));
  remote = join(dir, 'remote.git');
  work = join(dir, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-b', 'main', work]);
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'user.name', 'test');
  git(work, 'remote', 'add', 'origin', remote);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cut-runner-tag', () => {
  it('creates the tag at the commit it was given and pushes it', () => {
    const first = commitFile('a.txt', 'a\n');
    cutRunnerTag({ cwd: work, tag: 'runner-v0.17.1', commit: first });
    expect(tagTarget(work, 'runner-v0.17.1')).toBe(first);
    expect(git(work, 'ls-remote', '--tags', 'origin')).toContain('refs/tags/runner-v0.17.1');
  });

  it('tags the commit it was given and not the branch head', () => {
    const first = commitFile('a.txt', 'a\n');
    const second = commitFile('b.txt', 'b\n');
    cutRunnerTag({ cwd: work, tag: 'runner-v0.17.1', commit: first });
    expect(tagTarget(work, 'runner-v0.17.1')).toBe(first);
    expect(tagTarget(work, 'runner-v0.17.1')).not.toBe(second);
  });

  it('refuses a tag that already exists, naming it and where it points', () => {
    const first = commitFile('a.txt', 'a\n');
    cutRunnerTag({ cwd: work, tag: 'runner-v0.17.1', commit: first });
    const second = commitFile('b.txt', 'b\n');
    expect(() => cutRunnerTag({ cwd: work, tag: 'runner-v0.17.1', commit: second })).toThrow(
      new RegExp(`runner-v0\\.17\\.1 already exists at ${first}`),
    );
  });

  it('leaves the existing tag pointing where it did after the refusal', () => {
    const first = commitFile('a.txt', 'a\n');
    cutRunnerTag({ cwd: work, tag: 'runner-v0.17.1', commit: first });
    const second = commitFile('b.txt', 'b\n');
    try {
      cutRunnerTag({ cwd: work, tag: 'runner-v0.17.1', commit: second });
    } catch {
      // the refusal is the subject of the assertion above; this one is what it left
    }
    expect(tagTarget(work, 'runner-v0.17.1')).toBe(first);
    expect(git(work, 'ls-remote', '--tags', 'origin')).toContain(
      `${first}\trefs/tags/runner-v0.17.1`,
    );
  });

  it('takes the local tag back off when the remote refuses the push', () => {
    const first = commitFile('a.txt', 'a\n');
    // A tag the remote already holds but this checkout does not: the local create
    // succeeds and the push is refused, which is the race between two runs.
    const other = join(dir, 'other');
    execFileSync('git', ['clone', remote, other]);
    execFileSync('git', ['-C', other, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', other, 'config', 'user.name', 'test']);
    git(work, 'push', 'origin', 'main');
    execFileSync('git', ['-C', other, 'fetch', 'origin']);
    execFileSync('git', ['-C', other, 'checkout', '-B', 'main', 'origin/main']);
    writeFileSync(join(other, 'c.txt'), 'c\n');
    execFileSync('git', ['-C', other, 'add', 'c.txt']);
    execFileSync('git', ['-C', other, 'commit', '-m', 'c']);
    const theirs = execFileSync('git', ['-C', other, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['-C', other, 'tag', 'runner-v0.17.1', theirs]);
    execFileSync('git', ['-C', other, 'push', 'origin', 'refs/tags/runner-v0.17.1']);

    expect(() => cutRunnerTag({ cwd: work, tag: 'runner-v0.17.1', commit: first })).toThrow(
      /pushing runner-v0\.17\.1 to origin was refused, so no release was cut/,
    );
    expect(tagTarget(work, 'runner-v0.17.1')).toBeNull();
  });

  // A rerun of an older successful autorelease would allocate a HIGHER version from
  // today's tags and publish yesterday's code under it, moving every box numerically
  // forward and functionally back.
  it('refuses a commit some release already carries, naming that release', () => {
    const first = commitFile('a.txt', 'a\n');
    cutRunnerTag({ cwd: work, tag: 'runner-v0.17.1', commit: first });
    expect(() => cutRunnerTag({ cwd: work, tag: 'runner-v0.17.4', commit: first })).toThrow(
      /already released as runner-v0\.17\.1/,
    );
    expect(tagTarget(work, 'runner-v0.17.4')).toBeNull();
  });

  it('releases a commit no tag points at', () => {
    const first = commitFile('a.txt', 'a\n');
    expect(releasesAt(work, first)).toEqual([]);
    const second = commitFile('b.txt', 'b\n');
    cutRunnerTag({ cwd: work, tag: 'runner-v0.17.1', commit: first });
    expect(releasesAt(work, second)).toEqual([]);
    expect(() => cutRunnerTag({ cwd: work, tag: 'runner-v0.17.2', commit: second })).not.toThrow();
  });

  it('reads past a tag on that commit that is not a runner release', () => {
    const first = commitFile('a.txt', 'a\n');
    git(work, 'tag', 'v9.9.9', first);
    expect(releasesAt(work, first)).toEqual([]);
    expect(() => cutRunnerTag({ cwd: work, tag: 'runner-v0.17.1', commit: first })).not.toThrow();
  });

  it('answers null for a tag that does not exist', () => {
    commitFile('a.txt', 'a\n');
    expect(tagTarget(work, 'runner-v9.9.9')).toBeNull();
  });
});
