// @gate-input whole-tree — it reads a bare repository it builds through git, which the root-walk guard cannot see into.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REMOTE_FETCH_LIMITS } from './bounded-fetch.js';
import { gitRepositoryReader } from './repository-reading.js';

const root = mkdtempSync(join(tmpdir(), 'forge-repository-reading-'));
const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };
const author = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_COMMITTER_DATE: '2026-09-30T09:00:00Z',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...author } })
    .toString()
    .trim();
}

function commitFile(work: string, path: string, body: string, message: string): string {
  mkdirSync(join(work, path, '..'), { recursive: true });
  writeFileSync(join(work, path), body);
  git(work, 'add', path);
  git(work, 'commit', '--quiet', '-m', message);
  return git(work, 'rev-parse', 'HEAD');
}

let remote = '';
const sha: Record<string, string> = {};
let dirs = 0;

function reader(url = remote, limits = REMOTE_FETCH_LIMITS) {
  dirs += 1;
  return gitRepositoryReader(url, env, mkdtempSync(join(root, `read-${dirs}-`)), { limits });
}

beforeAll(() => {
  const work = join(root, 'work');
  git(root, 'init', '--quiet', '--initial-branch=production', work);
  sha.root = commitFile(work, 'README.md', 'r', 'chore: root');
  sha.shipped = commitFile(work, 'core/a.ts', 'a', 'feat(core): shipped (ISS-400)');
  git(work, 'checkout', '--quiet', '-b', 'main');
  sha.judged = commitFile(work, 'core/b.ts', 'b', 'fix(core): the judged change (ISS-423)');
  sha.after = commitFile(work, 'runner/r.rs', 'r', 'fix(runner): after it (ISS-424)');
  git(work, 'checkout', '--quiet', '-b', 'side', sha.shipped);
  sha.side = commitFile(work, 'web/w.tsx', 'w', 'feat(web): on a side branch');
  git(work, 'checkout', '--quiet', 'main');
  git(work, 'merge', '--quiet', '--no-ff', '-m', "Merge branch 'side'", 'side');
  sha.merge = git(work, 'rev-parse', 'HEAD');
  // Reachable only from a tag, which no branch fetch brings.
  git(work, 'checkout', '--quiet', '--detach', sha.shipped);
  sha.tagged = commitFile(work, 'docs/t.md', 't', 'docs: only on a tag (ISS-425)');
  git(work, 'tag', 'only-a-tag');
  git(work, 'checkout', '--quiet', 'main');
  // An orphan history sharing nothing with the others.
  git(work, 'checkout', '--quiet', '--orphan', 'orphan');
  sha.orphan = commitFile(work, 'x.txt', 'x', 'chore: unrelated root');
  git(work, 'checkout', '--quiet', 'main');
  remote = `file://${join(root, 'remote.git')}`;
  git(root, 'clone', '--quiet', '--bare', work, join(root, 'remote.git'));
  git(join(root, 'remote.git'), 'config', 'uploadpack.allowFilter', 'true');
  git(join(root, 'remote.git'), 'config', 'uploadpack.allowAnySHA1InWant', 'true');
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('commit', () => {
  it('reads a commit whole by its full sha: message, parents and committer date', async () => {
    const read = await reader().commit(sha.judged as string);
    expect(read).toEqual({
      kind: 'found',
      sha: sha.judged,
      message: 'fix(core): the judged change (ISS-423)',
      parents: [sha.shipped],
      committedAt: '2026-09-30T09:00:00Z',
    });
  });

  it('gives a merge its parents, the first parent first', async () => {
    const read = await reader().commit(sha.merge as string);
    expect(read.kind === 'found' && read.parents).toEqual([sha.after, sha.side]);
  });

  it('resolves an abbreviated sha, in either case, to the full one', async () => {
    const read = await reader().commit((sha.judged as string).slice(0, 9).toUpperCase());
    expect(read.kind === 'found' && read.sha).toBe(sha.judged);
  });

  it('fetches a full sha no branch holds by itself, and reads it', async () => {
    const read = await reader().commit(sha.tagged as string);
    expect(read.kind === 'found' && read.message).toBe('docs: only on a tag (ISS-425)');
  });

  it('answers absent for a full sha the repository does not hold, naming it', async () => {
    const missing = 'f'.repeat(40);
    expect(await reader().commit(missing)).toEqual({
      kind: 'absent',
      detail: `${remote} holds no commit ${missing}. Mark with the sha the work landed at`,
      details: { commit: missing, repository: remote },
    });
  });

  it('answers absent for a prefix no commit starts with, asking for the full sha', async () => {
    const read = await reader().commit('ffffffff');
    expect(read.kind).toBe('absent');
    expect(read.kind === 'absent' && read.detail).toContain('resolves no single commit from');
    expect(read.kind === 'absent' && read.detail).toContain('full 40-character sha');
  });

  it('answers a name shorter than a whole sha that no commit starts with as an unresolved prefix', async () => {
    const read = await reader().commit('f'.repeat(39));
    expect(read.kind === 'absent' && read.detail).toContain('resolves no single commit from');
  });

  it('answers absent for a name that is not a sha, without taking it as a ref', async () => {
    expect((await reader().commit('main')).kind).toBe('absent');
    expect((await reader().commit('--all')).kind).toBe('absent');
  });

  it('answers unreadable, naming why, where the repository cannot be fetched', async () => {
    const nowhere = `file://${join(root, 'nowhere.git')}`;
    const read = await reader(nowhere).commit(sha.judged as string);
    expect(read.kind).toBe('unreadable');
    expect(read.kind === 'unreadable' && read.why).toContain(`will not let it read ${nowhere}`);
    expect(read.kind === 'unreadable' && read.why).toContain(
      'does not appear to be a git repository',
    );
  });
});

// ISS-1398 r4: git resolves a held commit's 40 digits plus any tail once the commit is packed, so a
// name longer than a whole sha was read as that commit; the length is ruled on before git is asked.
describe('a name longer than the repository names a commit by', () => {
  const overlong = (name: string) =>
    `${remote} holds no commit ${name.toLowerCase()}: it is ${name.length} hex digits, and a commit there is named by its 40-digit sha or a prefix of it. Mark with the full 40-character sha the work landed at`;
  const tails = [
    ['41 digits', 'a'],
    ['63 digits', 'abcdef0123456789abcdef0'],
    ['64 digits, a SHA-256 length in a SHA-1 repository', 'abcdef0123456789abcdef01'],
    ['65 digits', 'abcdef0123456789abcdef012'],
  ];

  it.each(tails)('is refused absent at %s beginning with a held commit', async (_, tail) => {
    const name = `${sha.judged}${tail}`;
    expect(await reader().commit(name)).toEqual({
      kind: 'absent',
      detail: overlong(name),
      details: { commit: name, repository: remote },
    });
  });

  it('is refused absent in upper case too', async () => {
    const name = `${sha.judged}ABC`.toUpperCase();
    const read = await reader().commit(name);
    expect(read.kind === 'absent' && read.detail).toBe(overlong(name));
  });

  it('still reads a whole sha in upper case, and a short prefix, as the commit', async () => {
    const r = reader();
    const upper = await r.commit((sha.judged as string).toUpperCase());
    expect(upper.kind === 'found' && upper.sha).toBe(sha.judged);
    const short = await r.commit((sha.judged as string).slice(0, 7));
    expect(short.kind === 'found' && short.sha).toBe(sha.judged);
  });

  it('is never read as carried, as changed paths, as a range head or as contained', async () => {
    const r = reader();
    const name = `${sha.judged}a`;
    expect(await r.carriage(name, sha.merge as string)).toEqual({
      kind: 'unread',
      why: overlong(name).replace(/\. Mark with .*$/, ''),
    });
    expect(await r.carriage(sha.judged as string, `${sha.merge}a`)).toMatchObject({
      kind: 'unread',
    });
    expect((await r.changedPaths(`${sha.after}a`)).kind).toBe('unread');
    expect('why' in (await r.range('production', `${sha.merge}a`))).toBe(true);
    expect(await r.contains(name, 'main')).toEqual({
      why: overlong(name).replace(/\. Mark with .*$/, ''),
    });
  });
});

describe('branchHead and contains', () => {
  it("reads a branch's head", async () => {
    expect(await reader().branchHead('main')).toEqual({ sha: sha.merge });
  });

  it('says a branch holds a commit it holds, and not one it does not', async () => {
    const r = reader();
    expect(await r.contains(sha.judged as string, 'main')).toEqual({ contains: true });
    expect(await r.contains(sha.judged as string, 'production')).toEqual({ contains: false });
  });

  it('answers why, never contains, for a branch the repository does not have', async () => {
    expect(await reader().contains(sha.judged as string, 'staging')).toEqual({
      why: `${remote} has no branch staging`,
      missingBranch: 'staging',
    });
  });

  it('answers why, never contains, where the repository cannot be fetched', async () => {
    const read = await reader(`file://${join(root, 'nowhere.git')}`).contains(
      sha.judged as string,
      'main',
    );
    expect('why' in read && read.why).toContain('does not appear to be a git repository');
    expect('missingBranch' in read).toBe(false);
  });

  it('refuses a branch name git would not accept before fetching anything', async () => {
    expect(await reader().branchHead('bad..name')).toEqual({
      why: 'bad..name is not a branch name git accepts, so it cannot be read',
    });
  });
});

describe('carriage', () => {
  it('reads a served descendant, or the same commit, as carrying the judged one', async () => {
    const r = reader();
    expect(await r.carriage(sha.judged as string, sha.merge as string)).toEqual({
      kind: 'descends',
    });
    expect(await r.carriage(sha.judged as string, sha.judged as string)).toEqual({
      kind: 'descends',
    });
  });

  it('names every file the two sides changed since their merge base where it does not descend', async () => {
    const read = await reader().carriage(sha.judged as string, sha.side as string);
    expect(read).toEqual({ kind: 'differs', paths: ['core/b.ts', 'web/w.tsx'] });
  });

  it('is unread where the two commits share no history', async () => {
    const read = await reader().carriage(sha.judged as string, sha.orphan as string);
    expect(read).toEqual({
      kind: 'unread',
      why: `${sha.judged} and ${sha.orphan} share no history in ${remote}`,
    });
  });

  it('is unread, naming the commit, where the served commit is not in the repository', async () => {
    const read = await reader().carriage(sha.judged as string, 'e'.repeat(40));
    expect(read.kind === 'unread' && read.why).toContain(`holds no commit ${'e'.repeat(40)}`);
  });

  it('is unread, never descends, where the repository cannot be fetched', async () => {
    const read = await reader(`file://${join(root, 'nowhere.git')}`).carriage(
      sha.judged as string,
      sha.merge as string,
    );
    expect(read.kind).toBe('unread');
  });
});

describe('changedPaths', () => {
  it('reads the files a landing changed against its first parent', async () => {
    expect(await reader().changedPaths(sha.after as string)).toEqual({
      kind: 'read',
      paths: ['runner/r.rs'],
    });
  });

  it('reads a merge against its first parent, so the merged branch is what it changed', async () => {
    expect(await reader().changedPaths(sha.merge as string)).toEqual({
      kind: 'read',
      paths: ['web/w.tsx'],
    });
  });

  it('is unread for a root commit, which has no parent to diff against', async () => {
    expect(await reader().changedPaths(sha.root as string)).toEqual({
      kind: 'unread',
      why: `${sha.root} has no parent to diff it against`,
    });
  });
});

describe('range', () => {
  it('lists the commits the head holds and the base does not, oldest first, parents first-first', async () => {
    const read = await reader().range('production', sha.merge as string);
    expect('commits' in read).toBe(true);
    const commits = 'commits' in read ? read.commits : [];
    expect(commits.map((c) => c.sha).sort()).toEqual(
      [sha.judged, sha.after, sha.side, sha.merge].sort(),
    );
    expect(commits.at(-1)).toEqual({
      sha: sha.merge,
      parents: [sha.after, sha.side],
      message: "Merge branch 'side'",
    });
    const at = (s: string | undefined) => commits.findIndex((c) => c.sha === s);
    expect(at(sha.judged)).toBeLessThan(at(sha.after));
  });

  it('lists nothing where the base already holds the head', async () => {
    expect(await reader().range('main', sha.judged as string)).toEqual({ commits: [] });
  });

  it('answers why for a base branch the repository does not have', async () => {
    expect(await reader().range('staging', sha.merge as string)).toEqual({
      why: `${remote} has no branch staging`,
    });
  });
});

describe('the fetch budget', () => {
  it('refuses a reading whose fetch passes its byte budget, naming the budget', async () => {
    const fat = join(root, 'fat');
    git(root, 'init', '--quiet', '--initial-branch=main', fat);
    for (let i = 0; i < 20; i += 1) writeFileSync(join(fat, `f${i}.bin`), randomBytes(64 * 1024));
    git(fat, 'add', '.');
    git(fat, 'commit', '--quiet', '-m', 'files a host ignoring the filter would send');
    const head = git(fat, 'rev-parse', 'HEAD');
    // The source repository does not allow filters, so the fetch carries every file.
    const read = await reader(`file://${fat}`, {
      ...REMOTE_FETCH_LIMITS,
      maxBytes: 128 * 1024,
    }).commit(head);
    expect(read).toEqual({
      kind: 'unreadable',
      why: "fetching every branch's commits from the git host passed 128 KiB, the most one reading may fetch — the host may not honour the commits-only filter",
    });
  });

  it('refuses a reading whose fetch outlives its time budget', async () => {
    const read = await reader(remote, { ...REMOTE_FETCH_LIMITS, timeoutMs: 1 }).commit(
      sha.judged as string,
    );
    expect(read).toEqual({
      kind: 'unreadable',
      why: "fetching every branch's commits from the git host took longer than 0.001s",
    });
  });
});
