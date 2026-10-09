/**
 * REQ-6 BC-3 — "could not judge" through the route the web Judge posts to. The live QA of
 * dev.192/193 had no way to record it, so twelve such verdicts went in as Short and counted as
 * passing. A skipped verdict needs its reason, and never counts as a pass anywhere a count is shown:
 * the issue rail's tally, the requirement's coverage and the release criteria bar's fold. A person
 * judging again records a newer verdict, and the newest is the one counted. Through the app's own
 * routes, against real Postgres.
 */

import { criterionStandingOf } from '@forge/contracts/verdict-identity';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { totalsOf } from '../../src/release-batch/release-view.js';
import { api, userToken } from '../helpers/api.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';

const LIVE = '0d91ae7c74f70295ede115463b17559e650b5207';

let projectId: string;
let ownerId: string;
let token: string;
let unplant: (() => void) | null = null;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  // production serves LIVE, so a verdict judged at it is one coverage can check (ISS-489 r3)
  unplant = plantLiveBuild(LIVE);
});

afterEach(() => {
  unplant?.();
});

const onProject = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

/** A closed ISS-1 delivering an agreed requirement, its criterion 1 traced to BC-1. */
async function tracedClosedIssue(): Promise<{ issueId: string; req: string }> {
  const created = await onProject('POST', '/requirements', {
    title: 'Reminders',
    reason: 'planted',
    criteria: [{ body: 'A nurse sees the reminder' }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const req = String(created.body.key);
  for (const [path, body] of [
    [`/requirements/${req}/revisions/1/propose`, {}],
    [`/requirements/${req}/revisions/1/accept`, {}],
    [`/requirements/${req}/agree`, { revision: 1 }],
  ] as const) {
    const r = await onProject('POST', path, body);
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
  }
  const { id: issueId } = await createTestIssue(projectId, ownerId, 1, {
    status: 'closed',
    createdAt: new Date(),
    mergedAt: new Date(),
  });
  const linked = await onProject('POST', `/requirements/${req}/issues`, { issue: 'ISS-1' });
  expect(linked.status, JSON.stringify(linked.body)).toBeLessThan(300);
  const traced = await api(token, 'POST', `/api/issues/${issueId}/criteria/traces`, {
    codes: ['BC-1'],
  });
  expect(traced.status, JSON.stringify(traced.body)).toBe(201);
  return { issueId, req };
}

const judge = (issueId: string, verdict: string, reason: string | null) =>
  api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion: 1,
    verdict,
    reason,
    identity: { kind: 'commit', sha: LIVE },
    evidence: verdict === 'skipped' ? [] : ['reminder-1440.png'],
  });

/** Every count a person reads the criterion in: the rail's tally, the BC, and the release fold. */
async function counted(issueId: string, req: string) {
  const rail = await onProject('GET', '/issues/standing/ISS-1');
  expect(rail.status, JSON.stringify(rail.body)).toBe(200);
  const detail = await onProject('GET', `/requirements/${req}`);
  expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  const rows = await api(token, 'GET', `/api/issues/${issueId}/criteria`);
  expect(rows.status, JSON.stringify(rows.body)).toBe(200);
  const criteria = rows.body.criteria as Array<{
    latest: { verdict: string; identityKind: string | null } | null;
  }>;
  const coverage = (
    detail.body as { standing: { coverage: Array<{ code: string; verdict: string }> } }
  ).standing.coverage;
  return {
    latest: criteria[0]?.latest?.verdict ?? null,
    tally: (rail.body as { standing: { criteria: { passing: number; skipped: number } } }).standing
      .criteria,
    bc: coverage.find((c) => c.code === 'BC-1')?.verdict,
    release: totalsOf(criteria.map((c) => criterionStandingOf(c.latest as never))),
  };
}

describe('a person records "could not judge"', () => {
  it('is recorded as skipped with its reason and counts as a pass nowhere', async () => {
    const { issueId, req } = await tracedClosedIssue();

    const r = await judge(issueId, 'skipped', 'The property lives in the code, not on a screen.');

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.criterion).toMatchObject({
      latest: { verdict: 'skipped', reason: 'The property lives in the code, not on a screen.' },
    });
    expect(await counted(issueId, req)).toEqual({
      latest: 'skipped',
      tally: expect.objectContaining({ passing: 0, skipped: 1 }),
      bc: 'not_judged',
      release: { proven: 0, failing: 0, open: 1, total: 1 },
    });
  });

  it('is refused by name without its reason, and nothing is written', async () => {
    const { issueId, req } = await tracedClosedIssue();

    const r = await judge(issueId, 'skipped', '  ');

    expect(r.status).toBe(422);
    expect(
      (r.body.error as { refusals: Array<{ code: string; path: string }> }).refusals[0],
    ).toMatchObject({ code: 'VERDICT_SKIP_REASON_REQUIRED', path: '/reason' });
    expect((await counted(issueId, req)).latest).toBeNull();
  });

  it('a short counts as a pass, and judging it again as could not judge takes the pass away', async () => {
    const { issueId, req } = await tracedClosedIssue();
    expect((await judge(issueId, 'short', 'Met, short of its wording')).status).toBe(201);
    expect(await counted(issueId, req)).toMatchObject({
      tally: expect.objectContaining({ passing: 1, skipped: 0 }),
      bc: 'passing',
      release: { proven: 1, open: 0 },
    });

    expect((await judge(issueId, 'skipped', 'It was never on a screen to judge')).status).toBe(201);

    expect(await counted(issueId, req)).toMatchObject({
      latest: 'skipped',
      tally: expect.objectContaining({ passing: 0, skipped: 1 }),
      bc: 'not_judged',
      release: { proven: 0, open: 1 },
    });
  });

  it('judged again as a pass, the newest verdict is the one counted', async () => {
    const { issueId, req } = await tracedClosedIssue();
    expect((await judge(issueId, 'skipped', 'Not deployed when I looked')).status).toBe(201);

    expect((await judge(issueId, 'pass', 'Seen on the live deployment')).status).toBe(201);

    expect(await counted(issueId, req)).toMatchObject({
      latest: 'pass',
      tally: expect.objectContaining({ passing: 1, skipped: 0 }),
      bc: 'passing',
      release: { proven: 1, open: 0 },
    });
  });
});
