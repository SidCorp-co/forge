import { describe, expect, it } from 'vitest';
import { GitHubClientError, type GitHubRepoClient } from '../integrations/github/client.js';
import type { ReleaseChain } from '../projects/release-chain.js';
import { readRangeTo } from './cut-range.js';

const PROMOTE: ReleaseChain = [{ branch: 'main' }, { branch: 'production', from: 'merge-branch' }];
const HEAD = 'f'.repeat(40);

function client(answer: (path: string) => unknown, asked: string[] = []): GitHubRepoClient {
  return {
    fullName: 'o/r',
    get: async <T>(path: string) => {
      asked.push(path);
      return answer(path) as T;
    },
  } as unknown as GitHubRepoClient;
}

const page = (n: number, total: number, from = 0) => ({
  total_commits: total,
  commits: Array.from({ length: n }, (_, i) => ({
    sha: String(from + i).padStart(40, '0'),
    parents: [{ sha: 'p'.repeat(40) }],
    commit: { message: `m${from + i}` },
  })),
});

describe('readRangeTo (ISS-1386)', () => {
  it('pins the start branch to its head sha and reads live...head across pages', async () => {
    const asked: string[] = [];
    const range = await readRangeTo('p', PROMOTE, null, {
      client: async () =>
        client((path) => {
          if (path.endsWith('/commits/main')) return { sha: HEAD };
          return path.endsWith('&page=1') ? page(100, 150) : page(50, 150, 100);
        }, asked),
    });

    expect(range).toMatchObject({ kind: 'read', live: 'production', start: 'main', cut: HEAD });
    expect(range.kind === 'read' && range.commits).toHaveLength(150);
    expect(asked[1]).toContain(`/compare/production...${HEAD}?per_page=100&page=1`);
  });

  it('reads to a cut it is given without asking for the branch head', async () => {
    const asked: string[] = [];
    const cut = 'c'.repeat(40);
    const range = await readRangeTo('p', PROMOTE, cut, {
      client: async () => client(() => page(0, 0), asked),
    });

    expect(range).toMatchObject({ kind: 'read', cut, commits: [] });
    expect(asked).toHaveLength(1);
  });

  it('answers not-read for a publish chain and for a cherry-pick crossing, asking nothing', async () => {
    const never = async () => {
      throw new Error('asked');
    };
    const publish = await readRangeTo('p', [{ branch: 'main' }], null, { client: never });
    const picked = await readRangeTo(
      'p',
      [{ branch: 'main' }, { branch: 'production', from: 'cherry-pick' }],
      null,
      { client: never },
    );

    expect(publish.kind).toBe('not-read');
    expect(picked.kind).toBe('not-read');
  });

  it('tells a project with no binding from a binding that failed', async () => {
    const unbound = await readRangeTo('p', PROMOTE, null, {
      client: async () => {
        throw new GitHubClientError('no_binding', 'bind a repository');
      },
    });
    const failed = await readRangeTo('p', PROMOTE, null, {
      client: async () =>
        client(() => {
          throw new Error('502 from GitHub');
        }),
    });

    expect(unbound).toEqual({ kind: 'unbound', why: 'bind a repository' });
    expect(failed.kind).toBe('unread');
    expect(failed.kind === 'unread' && failed.why).toContain('502 from GitHub');
  });

  it('answers unread where a page comes back empty before the reported total is read', async () => {
    const range = await readRangeTo('p', PROMOTE, HEAD, {
      client: async () =>
        client((path) => (path.endsWith('&page=1') ? page(100, 150) : page(0, 150))),
    });

    expect(range.kind).toBe('unread');
    expect(range.kind === 'unread' && range.why).toMatch(/100 of the 150 commits/);
  });

  it('refuses to read a range longer than it pages through, rather than read part of it', async () => {
    const range = await readRangeTo('p', PROMOTE, HEAD, {
      client: async () => client(() => page(100, 5000)),
    });

    expect(range.kind).toBe('unread');
    expect(range.kind === 'unread' && range.why).toMatch(/more than 1000 commits/);
  });
});
