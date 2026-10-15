/**
 * A GitHub refusal reaches the person as GitHub said it. The repository list of a connection is a
 * GitHub read; when the installation's hourly budget is gone, /targets answers 424 with the window
 * named and `Retry-After` set, never 502 (which Cloudflare replaces with its own page), and asks
 * GitHub nothing more until the window resets.
 *
 * @direct-test-of packages/core/src/lib/provider-refusal.ts
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../helpers/api.js';
import { testEnv } from '../helpers/ecosystem-world.js';
import { truncateAll } from '../helpers/factories.js';
import {
  instanceApp,
  OURS,
  record,
  seedGithubWorld,
  stubGitHub,
} from '../helpers/github-instance-world.js';

let session = '';
let project = { id: '', slug: '', orgId: '' };

beforeAll(() => {
  testEnv();
});

beforeEach(async () => {
  await truncateAll();
  ({ session, project } = await seedGithubWorld());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/targets while GitHub rate-limits the installation', () => {
  it('PLANT: answers 424 with the refusal and its reset intact, and asks GitHub once', async () => {
    stubGitHub();
    const github = globalThis.fetch;
    const reset = Math.floor(Date.now() / 1000) + 328;
    let listed = 0;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (new URL(url).pathname !== '/installation/repositories') return github(input, init);
      listed += 1;
      return Response.json(
        { message: `API rate limit exceeded for installation ID ${OURS}.` },
        {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        },
      );
    });
    const connection = await instanceApp();
    await record(connection, OURS, project.orgId);

    for (const _ of [1, 2, 3]) {
      const res = await api(session, 'GET', `/api/integration-connections/${connection}/targets`);
      expect(res.status, JSON.stringify(res.body)).toBe(424);
      expect(res.body.code).toBe('GITHUB_REFUSED');
      expect(String(res.body.message ?? res.body.detail)).toContain(
        `GitHub rate limit, resets at ${new Date(reset * 1000).toISOString()}`,
      );
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(300);
    }
    expect(listed, 'the reads inside the window never reached GitHub').toBe(1);
  });
});
