import { describe, expect, it, vi } from 'vitest';
import { GitHubReadError, type GitHubRepoClient } from './client.js';
import { COMPARE_MAX_PAGES, COMPARE_PAGE_SIZE, readLiveDivergence } from './live-divergence.js';

const BASE = 'b'.repeat(40);
const LIVE = 'a'.repeat(40);

function client(get: (path: string) => unknown): GitHubRepoClient {
  return {
    bindingId: 'b',
    appId: '1',
    owner: 'SidCorp-co',
    repo: 'sid-desk',
    fullName: 'SidCorp-co/sid-desk',
    get: vi.fn(async (path: string) => get(path)) as unknown as GitHubRepoClient['get'],
    publish: async () => {
      throw new Error('a live reading must not publish');
    },
  };
}

function commits(from: number, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    sha: `c${String(from + i).padStart(39, '0')}`,
    commit: { message: `feat: change ${from + i} (ISS-${from + i})` },
  }));
}

function heads(path: string): unknown {
  if (path.endsWith('/git/ref/heads/staging')) return { object: { sha: BASE } };
  if (path.endsWith('/git/ref/heads/master')) return { object: { sha: LIVE } };
  return undefined;
}

const refs = { baseRef: 'staging', liveRef: 'master' };

describe('readLiveDivergence', () => {
  it('compares the two heads by sha and lists what base holds that live lacks', async () => {
    const seen: string[] = [];
    const c = client((path) => {
      seen.push(path);
      return heads(path) ?? { ahead_by: 2, commits: commits(1, 2) };
    });
    const d = await readLiveDivergence(c, refs);
    expect(d).toEqual({
      ok: true,
      baseSha: BASE,
      liveSha: LIVE,
      aheadBy: 2,
      commits: [
        { sha: commits(1, 1)[0]?.sha, message: 'feat: change 1 (ISS-1)' },
        { sha: commits(2, 1)[0]?.sha, message: 'feat: change 2 (ISS-2)' },
      ],
      complete: true,
    });
    expect(seen).toContain(
      `/repos/SidCorp-co/sid-desk/compare/${LIVE}...${BASE}?per_page=${COMPARE_PAGE_SIZE}&page=1`,
    );
  });

  it('pages until it holds every waiting commit', async () => {
    const c = client((path) => {
      const h = heads(path);
      if (h) return h;
      const page = Number(new URL(`https://x${path}`).searchParams.get('page'));
      return { ahead_by: 150, commits: page === 1 ? commits(0, 100) : commits(100, 50) };
    });
    const d = await readLiveDivergence(c, refs);
    expect(d.ok && d.commits.length).toBe(150);
    expect(d.ok && d.complete).toBe(true);
  });

  it('says the list was cut short when base is further ahead than the pages it reads', async () => {
    let page = 0;
    const c = client((path) => {
      const h = heads(path);
      if (h) return h;
      page += 1;
      return { ahead_by: 1000, commits: commits(page * 100, 100) };
    });
    const d = await readLiveDivergence(c, refs);
    expect(page).toBe(COMPARE_MAX_PAGES);
    expect(d).toMatchObject({ ok: true, aheadBy: 1000, complete: false });
    expect(d.ok && d.commits.length).toBe(COMPARE_MAX_PAGES * COMPARE_PAGE_SIZE);
  });

  it('answers a refusal carrying GitHub status when a branch cannot be read', async () => {
    const c = client((path) => {
      if (path.endsWith('/heads/master')) {
        throw new GitHubReadError(404, `GET ${path} on SidCorp-co/sid-desk returned HTTP 404`);
      }
      return heads(path);
    });
    const d = await readLiveDivergence(c, refs);
    expect(d.ok).toBe(false);
    expect(!d.ok && d.reason).toMatch(/heads\/master on SidCorp-co\/sid-desk returned HTTP 404/);
  });

  it('refuses rather than comparing against an empty head', async () => {
    const c = client((path) => (path.includes('/heads/') ? { object: {} } : { ahead_by: 0 }));
    const d = await readLiveDivergence(c, refs);
    expect(d).toEqual({
      ok: false,
      reason: 'SidCorp-co/sid-desk answered no commit for staging',
    });
  });

  it('encodes each segment of a branch name that holds a slash', async () => {
    const seen: string[] = [];
    const c = client((path) => {
      seen.push(path);
      return path.includes('/heads/') ? { object: { sha: BASE } } : { ahead_by: 0, commits: [] };
    });
    await readLiveDivergence(c, { baseRef: 'release/next', liveRef: 'prod' });
    expect(seen).toContain('/repos/SidCorp-co/sid-desk/git/ref/heads/release/next');
  });
});
