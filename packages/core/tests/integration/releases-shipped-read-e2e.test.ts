/**
 * ISS-1070 — a page showing the last few releases reads `GET /projects/:id/releases/shipped?limit=n`,
 * never the whole list: on forge-dev the list answered 955 KB in 2 s, and the shell and the
 * Dashboard read it on every route. The shipped read answers the newest `n` releases that shipped,
 * newest first, each summarised exactly as the whole list summarises it, and refuses a limit outside
 * 1..20 by name. Planted against real Postgres with releases recorded through
 * `POST /projects/:id/release-records`, in an order that is not the version order.
 *
 * @direct-test-of packages/core/src/release-batch/release-read.ts
 * @direct-test-of packages/core/src/release-batch/version-routes.ts
 * @direct-test-of packages/contracts/src/releases.ts
 */

import { RELEASES_SHIPPED_MAX } from '@forge/contracts/releases';
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from '../helpers/api.js';
import { BRANCH, F4, landedIssue, ok, seedLandedWorld, world } from '../helpers/landed-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const ACCOUNT = 'the deploy shipped the tag to production; /healthz reports the version.';

const onProject = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(world.token, method, `/api/projects/${world.projectId}${path}`, body);

let seq = 0;

async function recordRelease(version: string): Promise<void> {
  const res = await onProject('POST', '/release-records', {
    issueIds: [await landedIssue(++seq, F4)],
    version,
    account: ACCOUNT,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

type Summary = { version: string; releasedAt: string | null };

beforeEach(async () => {
  seq = 0;
  await seedLandedWorld();
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: BRANCH,
    environments: {
      production: {
        tier: 'production',
        deploysFrom: BRANCH,
        deployment: { mode: 'external', target: 'the-deploy' },
      },
    } as never,
    extra: { delivery: { verdictsRequired: false } } as never,
  });
});

describe('the newest shipped releases, read without the whole list (ISS-1070)', () => {
  it('answers the newest n by when they shipped, each as the whole list summarises it', async () => {
    // recorded out of version order: the newest shipped is the one recorded last
    for (const v of ['1.0.0', '1.2.0', '1.1.0', '1.3.0']) await recordRelease(v);

    const shipped = (await ok(onProject('GET', '/releases/shipped?limit=2'))) as {
      releases: Summary[];
    };
    expect(shipped.releases.map((r) => r.version)).toEqual(['1.3.0', '1.1.0']);
    expect(Object.keys(shipped)).toEqual(['releases']);

    const whole = (await ok(onProject('GET', '/releases'))) as { releases: Summary[] };
    for (const r of shipped.releases) {
      expect(r).toEqual(whole.releases.find((w) => w.version === r.version));
    }
  });

  it('answers every shipped release where fewer shipped than asked, and none on a project with none', async () => {
    const none = await ok(onProject('GET', '/releases/shipped?limit=3'));
    expect(none).toEqual({ releases: [] });

    await recordRelease('2.0.0');
    const one = (await ok(onProject('GET', `/releases/shipped?limit=${RELEASES_SHIPPED_MAX}`))) as {
      releases: Summary[];
    };
    expect(one.releases.map((r) => r.version)).toEqual(['2.0.0']);
  });

  it.each([
    ['no limit', '', 'RELEASES_SHIPPED_LIMIT'],
    ['a limit of 0', '?limit=0', 'RELEASES_SHIPPED_LIMIT'],
    [
      `a limit over ${RELEASES_SHIPPED_MAX}`,
      `?limit=${RELEASES_SHIPPED_MAX + 1}`,
      'RELEASES_SHIPPED_LIMIT',
    ],
    ['a limit that is no number', '?limit=all', 'RELEASES_SHIPPED_LIMIT'],
    ['a key it does not read', '?limit=2&state=shipped', 'UNKNOWN_QUERY_PARAMETER'],
  ])('refuses %s by name', async (_what, query, code) => {
    const res = await onProject('GET', `/releases/shipped${query}`);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect((res.body as { code: string }).code).toBe(code);
  });

  it('is never read as a release version', async () => {
    await recordRelease('3.0.0');
    const res = await onProject('GET', '/releases/shipped?limit=1');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('RELEASE_VERSION_SHAPE');
  });
});
