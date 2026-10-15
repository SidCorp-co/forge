// The GitHub client spends an installation's hourly budget once per question: a compare between two
// commits is read once and kept, identical reads in flight share one call, and once GitHub says the
// budget is gone no request leaves until the window it named resets.

import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRepoClient, forgetGitHubReads } from './client.js';
import { GitHubRateLimited, rateLimitedUntil } from './octokit.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const BASE = 'd5f27be2d0000000000000000000000000000000';
const HEAD = '6095cdd740000000000000000000000000000000';
let apps = 9000;

/** GitHub answering every repository read with `answer`, counting each one that reaches it. */
function stubGitHub(answer: (path: string) => Response) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
      return Response.json(
        { token: 'ghs_t', expires_at: new Date(Date.now() + 3600_000).toISOString() },
        { status: 201 },
      );
    }
    asked.push(path);
    return answer(path);
  });
  return asked;
}

/** A client of its own App, so no earlier test's tokens, throttle or window reach it. */
function client() {
  apps += 1;
  return buildRepoClient({
    bindingId: 'b1',
    config: { owner: 'SidCorp-co', repo: 'forge', installationId: 171606736 } as never,
    secrets: { appId: String(apps), privateKey } as never,
  });
}

const compare = (base: string, head: string, page = 1) =>
  `/repos/SidCorp-co/forge/compare/${base}...${head}?per_page=100&page=${page}`;

afterEach(() => {
  vi.unstubAllGlobals();
  forgetGitHubReads();
});

describe('a compare between two commits is asked once', () => {
  it('PLANT: N identical compare reads, at once and after, make one call', async () => {
    const asked = stubGitHub(() => Response.json({ status: 'ahead', files: [] }));
    const c = client();
    const at = await Promise.all(Array.from({ length: 9 }, () => c.get(compare(BASE, HEAD))));
    expect(at.every((a) => (a as { status: string }).status === 'ahead')).toBe(true);
    await c.get(compare(BASE, HEAD));
    await client().get(compare(BASE, HEAD));
    expect(asked).toEqual([`/repos/SidCorp-co/forge/compare/${BASE}...${HEAD}`]);
  });

  it('asks each page and each pair of its own, and never keeps a compare that names a branch', async () => {
    const asked = stubGitHub(() => Response.json({ status: 'ahead', files: [] }));
    const c = client();
    await c.get(compare(BASE, HEAD, 1));
    await c.get(compare(BASE, HEAD, 2));
    await c.get(compare(HEAD, BASE, 1));
    await c.get(compare(BASE, 'dev'));
    await c.get(compare(BASE, 'dev'));
    expect(asked).toHaveLength(5);
  });

  it('never keeps a failure: the same compare is asked again once GitHub answers', async () => {
    let fail = true;
    const asked = stubGitHub(() =>
      fail
        ? Response.json({ message: 'boom' }, { status: 422 })
        : Response.json({ status: 'ahead' }),
    );
    const c = client();
    await expect(c.get(compare(BASE, HEAD))).rejects.toThrow(/HTTP 422/);
    fail = false;
    await expect(c.get(compare(BASE, HEAD))).resolves.toEqual({ status: 'ahead' });
    expect(asked).toHaveLength(2);
  });
});

describe('a rate limit is a window, not a retry', () => {
  it('PLANT: once GitHub says the budget is gone, no read leaves until the reset it named', async () => {
    const reset = Math.floor(Date.now() / 1000) + 328;
    const asked = stubGitHub(() =>
      Response.json(
        { message: 'API rate limit exceeded for installation ID 171606736.' },
        {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        },
      ),
    );
    const c = client();
    const first = await c.get(compare(BASE, HEAD)).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(GitHubRateLimited);
    expect((first as GitHubRateLimited).message).toBe(
      `GitHub rate limit, resets at ${new Date(reset * 1000).toISOString()}`,
    );
    const later = await Promise.allSettled([
      c.get(compare(HEAD, BASE)),
      c.get('/repos/SidCorp-co/forge/branches/dev'),
      c.get('/repos/SidCorp-co/forge/pulls/1'),
    ]);
    for (const r of later) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(GitHubRateLimited);
      expect((r as PromiseRejectedResult).reason.status).toBe(429);
    }
    expect(asked, 'only the read GitHub refused reached it').toHaveLength(1);
  });

  it('forgets a window once its reset has passed', () => {
    expect(rateLimitedUntil('nobody')).toBeNull();
  });
});
