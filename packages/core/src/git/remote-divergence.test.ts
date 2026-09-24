import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchDivergence, REMOTE_MAX_COMMITS, readRemoteDivergence } from './remote-divergence.js';

const root = mkdtempSync(join(tmpdir(), 'forge-remote-divergence-'));
const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };
const author = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...author } })
    .toString()
    .trim();
}

let remote = '';
let liveSha = '';
let baseSha = '';
let dirs = 0;

function scratch(): string {
  dirs += 1;
  return mkdtempSync(join(root, `read-${dirs}-`));
}

beforeAll(() => {
  const work = join(root, 'work');
  git(root, 'init', '--quiet', '--initial-branch=master', work);
  git(work, 'commit', '--quiet', '--allow-empty', '-m', 'shipped: already on production (ISS-400)');
  liveSha = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '--quiet', '-b', 'staging');
  git(work, 'commit', '--quiet', '--allow-empty', '-m', 'fix(desk): a change (ISS-423)');
  git(work, 'checkout', '--quiet', '-b', 'side');
  git(work, 'commit', '--quiet', '--allow-empty', '-m', 'feat: the side work');
  git(work, 'checkout', '--quiet', 'staging');
  git(
    work,
    'merge',
    '--quiet',
    '--no-ff',
    'side',
    '-m',
    'Merge branch side into staging',
    '-m',
    'Closes ISS-419 and ISS-440',
  );
  baseSha = git(work, 'rev-parse', 'HEAD');
  remote = join(root, 'remote.git');
  git(root, 'clone', '--quiet', '--bare', work, remote);
  git(remote, 'config', 'uploadpack.allowFilter', 'true');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('fetchDivergence', () => {
  it('lists the commits on base that live lacks, each with its whole message', async () => {
    const d = await fetchDivergence(
      `file://${remote}`,
      env,
      { baseRef: 'staging', liveRef: 'master' },
      scratch(),
    );
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d).toMatchObject({ baseSha, liveSha, aheadBy: 3, complete: true });
    expect(d.commits.map((c) => c.message).sort()).toEqual([
      'Merge branch side into staging\n\nCloses ISS-419 and ISS-440',
      'feat: the side work',
      'fix(desk): a change (ISS-423)',
    ]);
    expect(d.commits[0]?.sha).toBe(baseSha);
    expect(d.commits.every((c) => /^[0-9a-f]{40}$/.test(c.sha))).toBe(true);
  });

  it('lists nothing where live already holds every commit on base', async () => {
    const d = await fetchDivergence(
      `file://${remote}`,
      env,
      { baseRef: 'master', liveRef: 'staging' },
      scratch(),
    );
    expect(d).toMatchObject({ ok: true, aheadBy: 0, commits: [], complete: true });
  });

  it('refuses by name a branch the repository does not have', async () => {
    const d = await fetchDivergence(
      `file://${remote}`,
      env,
      { baseRef: 'develop', liveRef: 'master' },
      scratch(),
    );
    expect(d).toEqual({
      ok: false,
      reason: 'the repository has no branch develop, so it cannot be compared',
    });
  });

  it('refuses a branch name git would not accept before fetching anything', async () => {
    const dir = scratch();
    const d = await fetchDivergence(
      `file://${remote}`,
      env,
      { baseRef: 'staging', liveRef: 'mas..ter' },
      dir,
    );
    expect(d).toEqual({
      ok: false,
      reason: 'mas..ter is not a branch name git accepts, so it cannot be fetched',
    });
    expect(() => git(join(dir, 'live-reading.git'), 'rev-parse', '--git-dir')).toThrow();
  });

  it('carries the git host answer when the fetch fails for another reason', async () => {
    const d = await fetchDivergence(
      `file://${join(root, 'nowhere.git')}`,
      env,
      { baseRef: 'staging', liveRef: 'master' },
      scratch(),
    );
    expect(d.ok).toBe(false);
    expect(!d.ok && d.reason).toMatch(/^the git host answered the fetch with: /);
  });

  it('says the list was cut short when more commits wait than a reading lists', async () => {
    const long = join(root, 'long');
    git(root, 'init', '--quiet', '--initial-branch=master', long);
    git(long, 'commit', '--quiet', '--allow-empty', '-m', 'root');
    const tree = git(long, 'rev-parse', 'HEAD^{tree}');
    let parent = git(long, 'rev-parse', 'HEAD');
    for (let i = 0; i <= REMOTE_MAX_COMMITS; i += 1) {
      parent = git(long, 'commit-tree', tree, '-p', parent, '-m', `waiting ${i}`);
    }
    git(long, 'update-ref', 'refs/heads/staging', parent);
    const d = await fetchDivergence(
      `file://${long}`,
      env,
      { baseRef: 'staging', liveRef: 'master' },
      scratch(),
    );
    expect(d).toMatchObject({ ok: true, aheadBy: REMOTE_MAX_COMMITS + 1, complete: false });
    expect(d.ok && d.commits.length).toBe(REMOTE_MAX_COMMITS);
  }, 120_000);
});

describe('readRemoteDivergence', () => {
  it('reaches a remote over ssh only, so no other transport is read with the deploy key', async () => {
    const d = await readRemoteDivergence(
      { repoUrl: `file://${remote}`, privateKey: 'not a key' },
      { baseRef: 'staging', liveRef: 'master' },
    );
    expect(d.ok).toBe(false);
    expect(!d.ok && d.reason).toMatch(/transport 'file' not allowed/);
  });
});
