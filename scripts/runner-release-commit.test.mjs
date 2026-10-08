// @gate-input whole-tree — its fixtures are git repositories, and the script it exercises reads a checkout's history whole.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runnerReleaseCommit } from './runner-release-commit.mjs';

// A real repository, because the subject is which commit git's own history walk
// names; a stub of that walk would only agree with the rule it was written from.
let dir;

const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

function write(path, body) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), body);
}

function commit(path, body = `${path}\n`) {
  write(path, body);
  git('add', path);
  git('commit', '-m', path);
  return git('rev-parse', 'HEAD');
}

/** Merge `branch` into main with a merge commit, the way the pull-request merge button does. */
function mergePullRequest(branch) {
  git('merge', '--no-ff', '-m', `Merge ${branch}`, branch);
  return git('rev-parse', 'HEAD');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runner-release-commit-'));
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  commit('README.md');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runnerReleaseCommit — which commit on main a runner change is released as', () => {
  it('names the merge commit for a pull request merged with one, not the pull request head', () => {
    git('checkout', '-b', 'feature');
    commit('packages/runner/a.rs');
    const head = commit('packages/runner/b.rs');
    git('checkout', 'main');
    const merge = mergePullRequest('feature');
    expect(runnerReleaseCommit({ cwd: dir })).toBe(merge);
    expect(runnerReleaseCommit({ cwd: dir })).not.toBe(head);
    // The property the release exists to give: the build carries its own merge.
    expect(() =>
      git('merge-base', '--is-ancestor', merge, runnerReleaseCommit({ cwd: dir })),
    ).not.toThrow();
  });

  it('names the merge commit when the last commit of the pull request touched nothing under the runner', () => {
    git('checkout', '-b', 'feature');
    commit('packages/runner/a.rs');
    commit('docs/note.md');
    git('checkout', 'main');
    const merge = mergePullRequest('feature');
    expect(runnerReleaseCommit({ cwd: dir })).toBe(merge);
  });

  it('names the commit itself for a push made straight to main', () => {
    commit('docs/before.md');
    const direct = commit('packages/runner/a.rs');
    expect(runnerReleaseCommit({ cwd: dir })).toBe(direct);
  });

  it('names the last runner commit of a rebased series, which main holds as its own commits', () => {
    commit('packages/runner/a.rs');
    const last = commit('packages/runner/b.rs');
    expect(runnerReleaseCommit({ cwd: dir })).toBe(last);
  });

  it('does not name the head of the push when an unrelated commit follows the runner change', () => {
    git('checkout', '-b', 'feature');
    commit('packages/runner/a.rs');
    git('checkout', 'main');
    const merge = mergePullRequest('feature');
    commit('docs/unrelated.md');
    expect(runnerReleaseCommit({ cwd: dir })).toBe(merge);
  });

  it('does not name the head of the push when an unrelated pull request is merged after the runner one', () => {
    git('checkout', '-b', 'runner');
    commit('packages/runner/a.rs');
    git('checkout', 'main');
    const runnerMerge = mergePullRequest('runner');
    git('checkout', '-b', 'docs');
    commit('docs/unrelated.md');
    git('checkout', 'main');
    mergePullRequest('docs');
    expect(runnerReleaseCommit({ cwd: dir })).toBe(runnerMerge);
  });

  it('names the later of two runner pull requests merged in one push', () => {
    git('checkout', '-b', 'one');
    commit('packages/runner/a.rs');
    git('checkout', 'main');
    mergePullRequest('one');
    git('checkout', '-b', 'two');
    commit('packages/runner/b.rs');
    git('checkout', 'main');
    const second = mergePullRequest('two');
    expect(runnerReleaseCommit({ cwd: dir })).toBe(second);
  });

  it('names a merge that changed the runner itself, which git lists as touching it', () => {
    write('packages/runner/a.rs', 'base\n');
    git('add', '.');
    git('commit', '-m', 'base');
    git('checkout', '-b', 'feature');
    commit('packages/runner/a.rs', 'feature\n');
    git('checkout', 'main');
    commit('packages/runner/a.rs', 'main\n');
    git('merge', '--no-ff', '--no-commit', '-X', 'ours', 'feature');
    write('packages/runner/a.rs', 'resolved by hand\n');
    git('add', '.');
    git('commit', '-m', 'Merge feature, resolved');
    const merge = git('rev-parse', 'HEAD');
    commit('docs/after.md');
    expect(runnerReleaseCommit({ cwd: dir })).toBe(merge);
  });

  it('reads the ref it is given and not the checked-out head', () => {
    git('checkout', '-b', 'feature');
    commit('packages/runner/a.rs');
    git('checkout', 'main');
    const merge = mergePullRequest('feature');
    commit('packages/runner/later.rs');
    expect(runnerReleaseCommit({ cwd: dir, ref: merge })).toBe(merge);
  });

  it('is refused by name where the history holds no commit under the runner package', () => {
    commit('docs/a.md');
    expect(() => runnerReleaseCommit({ cwd: dir })).toThrow(
      /no commit under packages\/runner is reachable from HEAD/,
    );
  });
});
