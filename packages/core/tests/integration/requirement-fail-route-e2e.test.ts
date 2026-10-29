/**
 * ISS-756 (FB-357; REQ-45 BC-2, BC-10, BC-12): a fail recorded on a business criterion at the
 * requirement goes to the issue that owns what is missing, never to one whose own criteria tracing
 * that criterion all pass.
 *
 * Planted from orbit: REQ-3 BC-3 ("GET /healthz answers the running version and commit") was traced
 * by ISS-16, closed with its commit half passing on production, and by ISS-18, still building the
 * version half. The master judged BC-3 fail at the requirement for the missing version, and the fail
 * reopened ISS-16 — picked as the newest landed issue tracing the BC, its own passes never read — so
 * a closed issue with nothing wrong in it sat at `reopen` with no legal way back but a re-walk.
 *
 * @direct-test-of packages/core/src/requirements/verdicts.ts
 * @direct-test-of packages/core/src/issues/fail-reopen.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '../../src/project-config/default-policy.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';

const NEW = '2222222222222222222222222222222222222222';
const LIVE = '9999999999999999999999999999999999999999';

let projectId: string;
let ownerId: string;
let token: string;
let unplant: (() => void) | null = null;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (
    await createTestProject(ownerId, { policy: { ...DEFAULT_POLICY, qa: 'independent' } })
  ).id;
  token = await userToken(ownerId);
  unplant = plantLiveBuild(LIVE, { [NEW]: true });
});

afterEach(() => {
  unplant?.();
  unplant = null;
});

const onProject = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

async function ok(r: Promise<{ status: number; body: Record<string, unknown> }>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

async function agreedRequirement(): Promise<string> {
  const created = await ok(
    onProject('POST', '/requirements', {
      title: 'Health',
      reason: 'planted',
      criteria: [{ body: 'Health answers the version and commit' }, { body: 'Health is public' }],
    }),
  );
  const key = String(created.key);
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  await ok(onProject('POST', `/requirements/${key}/revisions/1/propose`, {}));
  await ok(
    onProject('POST', `/requirements/${key}/revisions/1/accept`, {
      reason: 'Accepted for this test.',
    }),
  );
  await ok(
    onProject('POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Agreed with the owner for this test.',
    }),
  );
  return key;
}

type Landing = 'closed' | 'awaiting_release' | 'in_progress';

/** Issue `seq` tracing BC-1 of `req` at `status`, landed at `mergedAt` where it is past its build. */
async function tracing(req: string, seq: number, status: Landing, mergedAt: string | null) {
  const { id } = await createTestIssue(projectId, ownerId, seq, {
    status: 'open',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    mergedAt: mergedAt ? new Date(mergedAt) : null,
  });
  await ok(onProject('POST', `/requirements/${req}/issues`, { issue: `ISS-${seq}` }));
  await ok(api(token, 'POST', `/api/issues/${id}/criteria/traces`, { codes: ['BC-1'] }));
  await seedIssueStatus(id, status);
  return id;
}

/** A judge's pass on criterion 1 of `issueId` at the commit the live build holds. */
async function passed(issueId: string) {
  const res = await api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion: 1,
    verdict: 'pass',
    reason: 'the commit half answers on the running build',
    identity: { kind: 'commit', sha: NEW },
    evidence: ['healthz.txt'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

/** The master's fail on BC-1 at the requirement, as orbit's 08:18Z verdict was. */
async function failAtRequirement(req: string) {
  const res = await onProject('POST', `/requirements/${req}/verdicts`, {
    criterion: 'BC-1',
    verdict: 'fail',
    reason: 'the running build answers no version',
    identity: { kind: 'commit', sha: NEW },
    evidence: ['healthz.txt'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await settleOutbox();
  return res.body as {
    verdictId: string;
    routed?: { key: string; outcome: string; status: string; why: string }[];
    owner?: unknown;
  };
}

async function statusOf(issueId: string): Promise<string> {
  const [row] = await rows<{ status: string }>(
    sql`SELECT status FROM issues WHERE id = ${issueId}`,
  );
  return row?.status ?? 'missing';
}

async function saidOn(issueId: string): Promise<string[]> {
  return (
    await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${issueId} ORDER BY created_at`,
    )
  ).map((r) => r.body);
}

const outcomes = (body: Awaited<ReturnType<typeof failAtRequirement>>) =>
  Object.fromEntries((body.routed ?? []).map((r) => [r.key, r.outcome]));

describe('c1: a landed issue whose own tracing criteria pass stays where it is when another issue owns the rest', () => {
  it('leaves closed ISS-1 closed and says why on it, naming the BC, the verdict and ISS-2 (orbit ISS-16)', async () => {
    const req = await agreedRequirement();
    const delivered = await tracing(req, 1, 'closed', '2026-10-20T00:00:00Z');
    await passed(delivered);
    const building = await tracing(req, 2, 'in_progress', null);

    const body = await failAtRequirement(req);

    expect(await statusOf(delivered)).toBe('closed');
    expect(await statusOf(building)).toBe('in_progress');
    const said = (await saidOn(delivered)).join('\n');
    expect(said).toContain(`${req} BC-1`);
    expect(said).toContain(body.verdictId);
    expect(said).toContain('ISS-2');
  });

  it('leaves ISS-1 at awaiting release the same way', async () => {
    const req = await agreedRequirement();
    const delivered = await tracing(req, 1, 'awaiting_release', '2026-10-20T00:00:00Z');
    await passed(delivered);
    await tracing(req, 2, 'in_progress', null);

    await failAtRequirement(req);

    expect(await statusOf(delivered)).toBe('awaiting_release');
  });
});

describe('c2: the fail still reopens the issue that owns what failed', () => {
  it('reopens the landed issue whose own tracing criterion does not pass, not the newer one that passes', async () => {
    const req = await agreedRequirement();
    const unproven = await tracing(req, 1, 'closed', '2026-10-10T00:00:00Z');
    const delivered = await tracing(req, 2, 'closed', '2026-10-20T00:00:00Z');
    await passed(delivered);

    await failAtRequirement(req);

    expect(await statusOf(unproven)).toBe('reopen');
    expect(await statusOf(delivered)).toBe('closed');
  });

  it('reopens the only issue tracing the BC though its own criterion passed', async () => {
    const req = await agreedRequirement();
    const only = await tracing(req, 1, 'closed', '2026-10-20T00:00:00Z');
    await passed(only);

    await failAtRequirement(req);

    expect(await statusOf(only)).toBe('reopen');
  });

  it('reopens only the newest landing where every landed issue passes and none is building', async () => {
    const req = await agreedRequirement();
    const older = await tracing(req, 1, 'closed', '2026-10-10T00:00:00Z');
    const newer = await tracing(req, 2, 'closed', '2026-10-20T00:00:00Z');
    await passed(older);
    await passed(newer);

    await failAtRequirement(req);

    expect(await statusOf(newer)).toBe('reopen');
    expect(await statusOf(older)).toBe('closed');
    expect((await saidOn(older)).join('\n')).toContain('ISS-2');
  });
});

describe('c3: the answer names each issue the fail went to and what became of it', () => {
  it('answers ISS-1 stays, ISS-2 building, ISS-3 reopen', async () => {
    const req = await agreedRequirement();
    const delivered = await tracing(req, 1, 'closed', '2026-10-20T00:00:00Z');
    await passed(delivered);
    await tracing(req, 2, 'in_progress', null);
    await tracing(req, 3, 'closed', '2026-10-15T00:00:00Z');

    const body = await failAtRequirement(req);

    expect(outcomes(body)).toEqual({ 'ISS-1': 'stays', 'ISS-2': 'building', 'ISS-3': 'reopen' });
    expect(body.owner).toBeUndefined();
    for (const r of body.routed ?? []) expect(r.why.length).toBeGreaterThan(0);
  });

  it('answers an empty list where no issue traces the BC', async () => {
    const req = await agreedRequirement();

    const body = await failAtRequirement(req);

    expect(body.routed).toEqual([]);
  });
});
