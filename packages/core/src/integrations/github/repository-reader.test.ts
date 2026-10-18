import { describe, expect, it } from 'vitest';
import { GitHubReadError, type GitHubRepoClient } from './client.js';
import { githubRepositoryReader } from './repository-reader.js';

const SHA = '6de20f6092dcf9bdb1c8efe03db4b70c82b423dd';
const PARENT = '1111111111111111111111111111111111111111';

/**
 * A client answering as GitHub does (measured 2026-10-07 on api.github.com/repos/git/git): a commit
 * named by its 40 digits plus a tail is answered 200 as the 40-digit commit, and a compare from such
 * a name as if it were that commit.
 */
function github(): GitHubRepoClient & { asked: string[] } {
  const asked: string[] = [];
  const commit = {
    sha: SHA,
    parents: [{ sha: PARENT }],
    commit: { message: 'fix: it (ISS-7)', committer: { date: '2026-10-07T09:00:00Z' } },
  };
  return {
    bindingId: 'b',
    appId: '1',
    owner: 'o',
    repo: 'r',
    fullName: 'o/r',
    asked,
    async get<T>(path: string): Promise<T> {
      asked.push(path);
      if (path.toLowerCase().startsWith(`/repos/o/r/commits/${SHA}`)) return commit as T;
      if (path.includes('/compare/')) {
        return { status: 'identical', files: [], total_commits: 0, commits: [] } as T;
      }
      throw new GitHubReadError(404, `GET ${path} returned HTTP 404`);
    },
    async publish<T>(): Promise<T> {
      throw new Error('a repository read never publishes');
    },
  };
}

const overlong = (name: string) =>
  `o/r holds no commit ${name.toLowerCase()}: it is ${name.length} hex digits, and a commit there is named by its 40-digit sha or a prefix of it`;

describe('a name longer than a whole sha, on a GitHub binding', () => {
  it.each([
    ['41 digits', `${SHA}a`],
    ['64 digits', `${SHA}abcdef0123456789abcdef01`],
    ['upper case', `${SHA}ABC`.toUpperCase()],
  ])('is refused absent at %s without asking GitHub', async (_, name) => {
    const client = github();
    expect(await githubRepositoryReader(client).commit(name)).toEqual({
      kind: 'absent',
      detail: `${overlong(name)}. Mark with the full 40-character sha the work landed at`,
      details: { commit: name, repository: 'o/r' },
    });
    expect(client.asked).toEqual([]);
  });

  it('is never read as carried, as changed paths, as a range head or as contained', async () => {
    const client = github();
    const r = githubRepositoryReader(client);
    const name = `${SHA}a`;
    expect(await r.carriage(name, SHA)).toEqual({ kind: 'unread', why: overlong(name) });
    expect(await r.carriage(SHA, name)).toEqual({ kind: 'unread', why: overlong(name) });
    expect(await r.changedPaths(name)).toEqual({ kind: 'unread', why: overlong(name) });
    expect(await r.range('main', name)).toEqual({ why: overlong(name) });
    expect(await r.contains(name, 'main')).toEqual({ why: overlong(name) });
    expect(await r.descends(name, SHA)).toEqual({ why: overlong(name) });
    expect(await r.descends(SHA, name)).toEqual({ why: overlong(name) });
    expect(client.asked).toEqual([]);
  });

  it('still asks GitHub for a whole sha, in either case, with the same request as before', async () => {
    const client = github();
    const read = await githubRepositoryReader(client).commit(SHA.toUpperCase());
    expect(read.kind === 'found' && read.sha).toBe(SHA);
    expect(client.asked).toEqual([`/repos/o/r/commits/${SHA.toUpperCase()}`]);
  });
});

/**
 * ISS-1391 — which tags hold a commit, over a client answering as GitHub does: the tag list pages
 * 100 at a time with each tag's commit already peeled, and a compare from the landing to a tag
 * says `ahead` or `identical` exactly where the tag holds it.
 */
describe('tagsContaining, on a GitHub binding', () => {
  const LANDING = SHA;
  const HOLDER = 'a'.repeat(40);
  const OTHER = 'b'.repeat(40);

  const BROKEN = 'c'.repeat(40);

  function tagged(
    tags: Array<{ name: string; holds: boolean; broken?: boolean }>,
    opts: { failCompare?: boolean } = {},
  ): GitHubRepoClient & { asked: string[] } {
    const client = github();
    const shaOf = (t: { holds: boolean; broken?: boolean }) =>
      t.broken ? BROKEN : t.holds ? HOLDER : OTHER;
    return {
      ...client,
      async get<T>(path: string): Promise<T> {
        client.asked.push(path);
        if (path.toLowerCase().startsWith(`/repos/o/r/commits/${LANDING}`)) {
          return { sha: LANDING, parents: [], commit: { message: 'm' } } as T;
        }
        const page = /\/tags\?per_page=100&page=(\d+)/.exec(path);
        if (page) {
          const at = (Number(page[1]) - 1) * 100;
          return tags
            .slice(at, at + 100)
            .map((t) => ({ name: t.name, commit: { sha: shaOf(t) } })) as T;
        }
        const cmp = /\/compare\/[0-9a-f]+\.\.\.([0-9a-f]+)\?per_page=1$/.exec(path);
        if (cmp) {
          if (opts.failCompare) throw new GitHubReadError(500, `GET ${path} returned HTTP 500`);
          if (cmp[1] === BROKEN) throw new GitHubReadError(404, `GET ${path} returned HTTP 404`);
          return { status: cmp[1] === HOLDER ? 'ahead' : 'diverged' } as T;
        }
        throw new GitHubReadError(404, `GET ${path} returned HTTP 404`);
      },
    };
  }

  const compares = (c: { asked: string[] }) => c.asked.filter((p) => p.includes('/compare/'));

  it('names the matching tag that holds the commit, newest listed first, and asks nothing of a tag the pattern does not name', async () => {
    const client = tagged([
      { name: 'v1.1.0', holds: false },
      { name: 'v1.2.0', holds: true },
      { name: 'nightly-9', holds: true },
    ]);
    const read = await githubRepositoryReader(client).tagsContaining(LANDING, 'v*');
    expect(read).toEqual({
      commit: LANDING,
      matching: ['v1.2.0', 'v1.1.0'],
      containing: ['v1.2.0'],
    });
    expect(compares(client)).toHaveLength(2);
  });

  it('answers no containing tag where none holds the commit, listing the matching ones', async () => {
    const read = await githubRepositoryReader(
      tagged([
        { name: 'v1.18.0', holds: false },
        { name: 'v1.9.0', holds: false },
      ]),
    ).tagsContaining(LANDING, 'v*');
    expect(read).toEqual({ commit: LANDING, matching: ['v1.18.0', 'v1.9.0'], containing: [] });
  });

  it('finds the sole tag that holds the commit when it is the oldest of 120, past the first tag page', async () => {
    const all = Array.from({ length: 120 }, (_, i) => ({ name: `v1.${i + 1}.0`, holds: i === 0 }));
    const client = tagged(all);
    const read = await githubRepositoryReader(client).tagsContaining(LANDING, 'v*');
    expect(read).toMatchObject({ commit: LANDING, containing: ['v1.1.0'] });
    expect('matching' in read && read.matching).toHaveLength(120);
    expect(compares(client)).toHaveLength(120);
  });

  it('stops comparing after the first batch that holds the commit', async () => {
    const all = Array.from({ length: 120 }, (_, i) => ({ name: `v1.${i + 1}.0`, holds: true }));
    const client = tagged(all);
    const read = await githubRepositoryReader(client).tagsContaining(LANDING, 'v*');
    expect(read).toMatchObject({ commit: LANDING });
    expect(compares(client)).toHaveLength(10);
  });

  it('reads a repository holding exactly the most tags one reading lists', async () => {
    const all = Array.from({ length: 1000 }, (_, i) => ({ name: `v1.${i + 1}.0`, holds: true }));
    const read = await githubRepositoryReader(tagged(all)).tagsContaining(LANDING, 'v*');
    expect(read).toMatchObject({ commit: LANDING });
    expect('why' in read).toBe(false);
  });

  it('refuses a repository with more tags than one reading lists, rather than reading part of them', async () => {
    const all = Array.from({ length: 1001 }, (_, i) => ({ name: `v1.${i + 1}.0`, holds: true }));
    const client = tagged(all);
    const read = await githubRepositoryReader(client).tagsContaining(LANDING, 'v*');
    expect(read).toEqual({
      why: 'o/r holds more than 1000 tags, more than one reading lists whole, so whether a tag holds the commit cannot be read',
    });
    expect(compares(client)).toEqual([]);
  });

  it('finds a tag that holds the commit though another compare in the same batch fails', async () => {
    const read = await githubRepositoryReader(
      tagged([
        { name: 'v1.3.0', holds: false, broken: true },
        { name: 'v1.2.0', holds: true },
      ]),
    ).tagsContaining(LANDING, 'v*');
    expect(read).toMatchObject({ commit: LANDING, containing: ['v1.2.0'] });
  });

  it('finds a tag in a later batch though a compare in an earlier one failed', async () => {
    const all = Array.from({ length: 25 }, (_, i) => ({
      name: `v1.${25 - i}.0`,
      holds: i === 24,
      broken: i === 3,
    }));
    const read = await githubRepositoryReader(tagged(all)).tagsContaining(LANDING, 'v*');
    expect(read).toMatchObject({ commit: LANDING, containing: ['v1.1.0'] });
  });

  it('says why, rather than answering that no tag holds the commit, where a compare failed and none does', async () => {
    const read = await githubRepositoryReader(
      tagged([
        { name: 'v1.2.0', holds: false, broken: true },
        { name: 'v1.1.0', holds: false },
      ]),
    ).tagsContaining(LANDING, 'v*');
    expect(read).toMatchObject({ why: expect.stringContaining('HTTP 404') });
  });

  it('says why where a compare fails, rather than answering that no tag holds the commit', async () => {
    const read = await githubRepositoryReader(
      tagged([{ name: 'v1.0.0', holds: true }], { failCompare: true }),
    ).tagsContaining(LANDING, 'v*');
    expect(read).toMatchObject({
      why: expect.stringContaining('o/r could not read which tags hold'),
    });
  });

  it('says why where the commit is unknown to the repository', async () => {
    const read = await githubRepositoryReader(tagged([])).tagsContaining('c'.repeat(40), 'v*');
    expect(read).toMatchObject({ why: expect.stringContaining('HTTP 404') });
  });

  it('refuses a name longer than a whole sha without asking GitHub', async () => {
    const client = tagged([]);
    const name = `${LANDING}a`;
    expect(await githubRepositoryReader(client).tagsContaining(name, 'v*')).toEqual({
      why: overlong(name),
    });
    expect(client.asked).toEqual([]);
  });
});

/** Round 7 of ISS-1421: whether a later landing carries the one a mark holds, from one compare's status. */
describe('descends, on a GitHub binding', () => {
  const LATER = '2222222222222222222222222222222222222222';
  function comparing(status: string | null | Error): GitHubRepoClient & { asked: string[] } {
    const asked: string[] = [];
    return {
      bindingId: 'b',
      appId: '1',
      owner: 'o',
      repo: 'r',
      fullName: 'o/r',
      asked,
      async get<T>(path: string): Promise<T> {
        asked.push(path);
        if (status instanceof Error) throw status;
        return (status === null ? {} : { status }) as T;
      },
      async publish<T>(): Promise<T> {
        throw new Error('a repository read never publishes');
      },
    };
  }

  it.each([
    ['ahead', true],
    ['identical', true],
    ['behind', false],
    ['diverged', false],
  ])('reads %s as contains %s, asking one page of one commit', async (status, contains) => {
    const client = comparing(status);
    expect(await githubRepositoryReader(client).descends(SHA, LATER)).toEqual({ contains });
    expect(client.asked).toEqual([`/repos/o/r/compare/${SHA}...${LATER}?per_page=1`]);
  });

  it('says why where the compare answers no status or fails, never that it does not descend', async () => {
    expect(await githubRepositoryReader(comparing(null)).descends(SHA, LATER)).toEqual({
      why: 'o/r answered no compare status',
    });
    const failed = await githubRepositoryReader(
      comparing(new GitHubReadError(404, 'GET compare returned HTTP 404')),
    ).descends(SHA, LATER);
    expect('why' in failed && failed.why).toContain(`o/r could not compare ${SHA} with ${LATER}`);
  });
});
