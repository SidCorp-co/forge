/**
 * What the two reads answer, and what they answer when they cannot.
 *
 * The fencing half — that a refresh for an overtaken head writes nothing — is a
 * property of one UPDATE's WHERE and is proved against Postgres in
 * `tests/integration/repo-projection-e2e.test.ts`. A stub whose `where` returns
 * itself would make that case pass with the predicate deleted, which is the
 * proof-by-absence ISS-1071's own F2 was filed for.
 */

import { describe, expect, it, vi } from 'vitest';
import { GitHubClientError, GitHubReadError, type GitHubRepoClient } from './client.js';
import { CAP_REACHED_REASON, readRefreshFacts } from './projection-refresh.js';

const HEAD = 'a'.repeat(40);

function client(get: GitHubRepoClient['get']): GitHubRepoClient {
  return {
    bindingId: 'b',
    appId: '1',
    owner: 'SidCorp-co',
    repo: 'forge',
    fullName: 'SidCorp-co/forge',
    get,
    publish: async () => {
      throw new Error('projection refresh must not publish');
    },
  };
}

describe('the two reads an event invalidated', () => {
  it('takes mergeability from the pull and the counts from the compare', async () => {
    const get = vi.fn(async (path: string) =>
      path.includes('/compare/')
        ? { ahead_by: 3, behind_by: 7, base_commit: { sha: 'c'.repeat(40) } }
        : { mergeable: false, mergeable_state: 'dirty' },
    ) as unknown as GitHubRepoClient['get'];

    await expect(
      readRefreshFacts(client(get), { number: 5, baseRef: 'main', headSha: HEAD }),
    ).resolves.toEqual({
      ok: true,
      behindBy: 7,
      aheadBy: 3,
      mergeable: false,
      mergeableState: 'dirty',
      baseSha: 'c'.repeat(40),
    });
  });

  it('compares against the base branch as it is now, not against the stored base sha', async () => {
    const seen: string[] = [];
    const get = vi.fn(async (path: string) => {
      seen.push(path);
      return path.includes('/compare/') ? { ahead_by: 0, behind_by: 0 } : {};
    }) as unknown as GitHubRepoClient['get'];

    await readRefreshFacts(client(get), { number: 5, baseRef: 'main', headSha: HEAD });
    expect(seen[1]).toBe(`/repos/SidCorp-co/forge/compare/main...${HEAD}`);
  });

  it('stores an unknown mergeability as the answer rather than retrying for one', async () => {
    const get = vi.fn(async (path: string) =>
      path.includes('/compare/')
        ? { ahead_by: 1, behind_by: 0 }
        : { mergeable: null, mergeable_state: 'unknown' },
    ) as unknown as GitHubRepoClient['get'];

    const out = await readRefreshFacts(client(get), { number: 5, baseRef: 'main', headSha: HEAD });
    expect(out).toMatchObject({ ok: true, mergeable: null, mergeableState: 'unknown' });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('answers null counts where the compare omits them rather than inventing a zero', async () => {
    const get = (async () => ({})) as unknown as GitHubRepoClient['get'];
    await expect(
      readRefreshFacts(client(get), { number: 5, baseRef: 'main', headSha: HEAD }),
    ).resolves.toMatchObject({ ok: true, behindBy: null, aheadBy: null });
  });

  it('reports a refused read as a reason and never as a throw', async () => {
    const get = (async () => {
      throw new GitHubReadError(403, 'GET /x on SidCorp-co/forge returned HTTP 403');
    }) as unknown as GitHubRepoClient['get'];
    await expect(
      readRefreshFacts(client(get), { number: 5, baseRef: 'main', headSha: HEAD }),
    ).resolves.toEqual({ ok: false, reason: 'GET /x on SidCorp-co/forge returned HTTP 403' });
  });

  it('reports a missing credential as a reason too, with the sentence an operator acts on', async () => {
    const get = (async () => {
      throw new GitHubClientError('no_installation', 'the App is not installed for that binding');
    }) as unknown as GitHubRepoClient['get'];
    const out = await readRefreshFacts(client(get), { number: 5, baseRef: 'main', headSha: HEAD });
    expect(out).toMatchObject({ ok: false });
    expect(out.ok === false && out.reason).toMatch(/not installed/);
  });

  it('reports a network failure by its own text, so a timeout does not fail the delivery', async () => {
    const get = (async () => {
      throw new Error('The operation was aborted due to timeout');
    }) as unknown as GitHubRepoClient['get'];
    const out = await readRefreshFacts(client(get), { number: 5, baseRef: 'main', headSha: HEAD });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(/aborted due to timeout/);
  });

  it('refuses the pair when GitHub answers for a head this read was not about', async () => {
    const get = vi.fn(async () => ({
      head: { sha: 'z'.repeat(40) },
      mergeable: true,
    })) as unknown as GitHubRepoClient['get'];
    const out = await readRefreshFacts(client(get), { number: 5, baseRef: 'main', headSha: HEAD });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(
      /GitHub answered for head z+ while this read was for a+/,
    );
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('refuses the pair when the pull request has been retargeted to another base', async () => {
    const get = vi.fn(async () => ({
      head: { sha: HEAD },
      base: { ref: 'release' },
    })) as unknown as GitHubRepoClient['get'];
    const out = await readRefreshFacts(client(get), { number: 5, baseRef: 'main', headSha: HEAD });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(
      /answered for base release while this read was for main/,
    );
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('accepts an answer that names the head and base it was asked about', async () => {
    const get = (async (path: string) =>
      path.includes('/compare/')
        ? { ahead_by: 1, behind_by: 2 }
        : {
            head: { sha: HEAD },
            base: { ref: 'main' },
            mergeable: true,
            mergeable_state: 'clean',
          }) as unknown as GitHubRepoClient['get'];
    await expect(
      readRefreshFacts(client(get), { number: 5, baseRef: 'main', headSha: HEAD }),
    ).resolves.toMatchObject({ ok: true, behindBy: 2, mergeableState: 'clean' });
  });

  it('refuses the pair when the base moved between the two reads', async () => {
    const get = (async (path: string) =>
      path.includes('/compare/')
        ? { ahead_by: 1, behind_by: 5, base_commit: { sha: 'd'.repeat(40) } }
        : {
            head: { sha: HEAD },
            base: { ref: 'main', sha: 'c'.repeat(40) },
            mergeable: true,
            mergeable_state: 'clean',
          }) as unknown as GitHubRepoClient['get'];
    const out = await readRefreshFacts(client(get), { number: 5, baseRef: 'main', headSha: HEAD });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(
      /main moved from c+ to d+ between the two reads/,
    );
  });

  it('accepts the pair when the base is the same commit in both reads', async () => {
    const get = (async (path: string) =>
      path.includes('/compare/')
        ? { ahead_by: 1, behind_by: 5, base_commit: { sha: 'c'.repeat(40) } }
        : {
            head: { sha: HEAD },
            base: { ref: 'main', sha: 'c'.repeat(40) },
            mergeable: true,
            mergeable_state: 'clean',
          }) as unknown as GitHubRepoClient['get'];
    await expect(
      readRefreshFacts(client(get), { number: 5, baseRef: 'main', headSha: HEAD }),
    ).resolves.toMatchObject({ ok: true, behindBy: 5, mergeableState: 'clean' });
  });

  it('does not reach the compare when the pull read already failed', async () => {
    const get = vi.fn(async () => {
      throw new GitHubReadError(404, 'gone');
    }) as unknown as GitHubRepoClient['get'];
    await readRefreshFacts(client(get), { number: 5, baseRef: 'main', headSha: HEAD });
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('the cap a base push stops at', () => {
  it('names the cap and says what the number beside it is', () => {
    expect(CAP_REACHED_REASON).toMatch(/more than 25 open pull requests/);
    expect(CAP_REACHED_REASON).toMatch(/from before the push/);
  });
});
