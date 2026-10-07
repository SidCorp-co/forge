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
    expect(client.asked).toEqual([]);
  });

  it('still asks GitHub for a whole sha, in either case, with the same request as before', async () => {
    const client = github();
    const read = await githubRepositoryReader(client).commit(SHA.toUpperCase());
    expect(read.kind === 'found' && read.sha).toBe(SHA);
    expect(client.asked).toEqual([`/repos/o/r/commits/${SHA.toUpperCase()}`]);
  });
});
