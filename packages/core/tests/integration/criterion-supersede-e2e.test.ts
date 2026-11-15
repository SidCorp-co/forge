/**
 * A landed issue's criterion that a later issue changed on purpose, retired as superseded by it
 * (REQ-48 BC-18, ISS-1240). agenfold FB-645: ISS-311 replaced ISS-228's cost-per-day chart on the
 * owner's direction, a runtime re-judge on a later build failed ISS-228 criterion 1, and the fail
 * reopened the closed issue; nothing could record that the change was deliberate. Through the app's
 * own routes and its outbox, against real Postgres.
 *
 * @direct-test-of packages/core/src/issues/criteria/supersede.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ApiResponse, api, userToken } from '../helpers/api.js';
import type { Doc } from '../helpers/ecosystem-world.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';

const NEW = '3333333333333333333333333333333333333333';
const LIVE = '9999999999999999999999999999999999999999';
const CHART = 'The spend page shows a cost-per-day chart';
const TOTAL = 'The spend page shows the month total';
const LEDGER = 'The spend page shows ledger spend only, with no per-day chart';
const WHY =
  'ISS-2 replaced the per-day chart on the owner direction that spend is ledger spend only';

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
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  unplant = plantLiveBuild(LIVE, { [NEW]: true });
});

afterEach(() => {
  unplant?.();
  unplant = null;
});

const codes = (res: ApiResponse): string[] =>
  (((res.body as Doc).error?.refusals ?? []) as Doc[]).map((r) => String(r.code));

async function ok(r: Promise<ApiResponse>, status?: number): Promise<Doc> {
  const res = await r;
  if (status === undefined) expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  else expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as Doc;
}

/** Issue `seq` with `criteria`, landed on NEW and moved to `status`. */
async function issue(
  seq: number,
  criteria: string[],
  status: 'closed' | 'awaiting_release' | 'in_progress',
  inProject = projectId,
) {
  const { id } = await createTestIssue(inProject, ownerId, seq, {
    status: 'in_progress',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    mergedAt: status === 'in_progress' ? null : new Date('2026-10-20T00:00:00Z'),
  });
  await ok(
    api(token, 'PUT', `/api/issues/${id}/criteria`, {
      criteria: criteria.map((statement) => ({ statement })),
    }),
  );
  if (status !== 'in_progress') {
    await rows(sql`UPDATE issues SET merged_commit_sha = ${NEW} WHERE id = ${id}`);
    await seedIssueStatus(id, status);
  }
  return id;
}

const supersede = (issueId: string, n: number, body: Record<string, unknown>) =>
  api(token, 'POST', `/api/issues/${issueId}/criteria/${n}/supersede`, body);

const failOn = (issueId: string, criterion: number) =>
  api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion,
    verdict: 'fail',
    reason: 'the per-day chart is gone',
    identity: { kind: 'commit', sha: NEW },
    evidence: ['spend.png'],
  });

const statusOf = async (id: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`))[0]?.status;

const liveNs = async (id: string) =>
  (
    await rows<{ n: number }>(
      sql`SELECT n FROM issue_criteria WHERE issue_id = ${id} AND retired_at IS NULL ORDER BY n`,
    )
  ).map((r) => Number(r.n));

describe('c1: a landed criterion a later landed issue changed on purpose is retired as superseded by it', () => {
  it('retires ISS-1 criterion 1 naming ISS-2 criterion 1, records why, and the read lists it superseded (agenfold ISS-228)', async () => {
    const closed = await issue(1, [CHART, TOTAL], 'closed');
    const later = await issue(2, [LEDGER], 'closed');
    const body = await ok(supersede(closed, 1, { by: 'ISS-2', criterion: 1, reason: WHY }), 201);
    expect(body.superseded).toMatchObject({
      n: 1,
      supersededBy: { issue: expect.stringMatching(/-2$/), criterion: 1 },
      reason: WHY,
    });
    expect(await liveNs(closed)).toEqual([2]);
    const [moved] = await rows<{ to: string | null; later: string }>(sql`
      SELECT c.moved_to_criterion_id AS to, l.id AS later FROM issue_criteria c
        JOIN issue_criteria l ON l.issue_id = ${later} AND l.n = 1 AND l.retired_at IS NULL
       WHERE c.issue_id = ${closed} AND c.n = 1`);
    expect(moved?.to).toBe(moved?.later);
    const read = await ok(api(token, 'GET', `/api/issues/${closed}/criteria`), 200);
    expect((read.criteria as Doc[]).map((c) => c.n)).toEqual([2]);
    expect((read.retired as Doc[])[0]).toMatchObject({
      n: 1,
      statement: CHART,
      supersededBy: { criterion: 1, reason: WHY },
    });
    const [text] = await rows<{ t: string | null }>(
      sql`SELECT acceptance_criteria AS t FROM issues WHERE id = ${closed}`,
    );
    expect(text?.t).not.toContain(CHART);
    expect(await statusOf(closed)).toBe('closed');
  });

  it('takes an issue at awaiting_release superseded by one at awaiting_release', async () => {
    const landed = await issue(1, [CHART, TOTAL], 'awaiting_release');
    await issue(2, [LEDGER], 'awaiting_release');
    await ok(supersede(landed, 1, { by: 'ISS-2', criterion: 1, reason: WHY }), 201);
    expect(await liveNs(landed)).toEqual([2]);
  });
});

describe('c2: a supersede that cannot stand is refused by name, writing nothing', () => {
  it('refuses the issue itself, an unknown or foreign issue, an unlanded later issue, a criterion live on neither, an issue not landed, and no reason', async () => {
    const closed = await issue(1, [CHART, TOTAL], 'closed');
    await issue(2, [LEDGER], 'closed');
    await issue(3, ['The spend page is rebuilt'], 'in_progress');
    const building = await issue(4, [CHART], 'in_progress');
    const other = (await createTestProject(ownerId)).id;
    await issue(5, [LEDGER], 'closed', other);

    const self = await supersede(closed, 1, { by: 'ISS-1', criterion: 2, reason: WHY });
    expect(codes(self)).toEqual(['CRITERION_SUPERSEDE_SELF']);
    const unknown = await supersede(closed, 1, { by: 'ISS-99', criterion: 1, reason: WHY });
    expect(codes(unknown)).toEqual(['CRITERION_SUPERSEDE_BY_UNKNOWN']);
    const foreign = await supersede(closed, 1, { by: 'ISS-5', criterion: 1, reason: WHY });
    expect(codes(foreign)).toEqual(['CRITERION_SUPERSEDE_BY_UNKNOWN']);
    const unlanded = await supersede(closed, 1, { by: 'ISS-3', criterion: 1, reason: WHY });
    expect(codes(unlanded)).toEqual(['CRITERION_SUPERSEDE_BY_UNLANDED']);
    const noTarget = await supersede(closed, 1, { by: 'ISS-2', criterion: 9, reason: WHY });
    expect(codes(noTarget)).toEqual(['CRITERION_UNKNOWN']);
    const noOwn = await supersede(closed, 7, { by: 'ISS-2', criterion: 1, reason: WHY });
    expect(codes(noOwn)).toEqual(['CRITERION_UNKNOWN']);
    const early = await supersede(building, 1, { by: 'ISS-2', criterion: 1, reason: WHY });
    expect(codes(early)).toEqual(['CRITERION_SUPERSEDE_NOT_LANDED']);
    const noReason = await supersede(closed, 1, { by: 'ISS-2', criterion: 1, reason: ' ' });
    expect(noReason.status).toBe(400);

    expect(await liveNs(closed)).toEqual([1, 2]);
    expect(await liveNs(building)).toEqual([1]);
    const [logged] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM activity_log WHERE action = 'issue.criterion.superseded'`);
    expect(Number(logged?.n)).toBe(0);
  });
});

describe('c3: a verdict on a superseded criterion is refused naming the later issue, and never reopens', () => {
  it('refuses a fail on ISS-1 criterion 1 naming ISS-2 criterion 1, and ISS-1 stays closed', async () => {
    const closed = await issue(1, [CHART, TOTAL], 'closed');
    await issue(2, [LEDGER], 'closed');
    await ok(supersede(closed, 1, { by: 'ISS-2', criterion: 1, reason: WHY }), 201);
    const res = await failOn(closed, 1);
    expect(codes(res)).toEqual(['VERDICT_CRITERION_UNKNOWN']);
    expect(JSON.stringify(res.body)).toMatch(/superseded by [A-Z]+-2 criterion 1/);
    expect(JSON.stringify(res.body)).toContain(WHY);
    await settleOutbox();
    expect(await statusOf(closed)).toBe('closed');
  });

  it('still reopens ISS-1 on a fail on criterion 2, which nothing superseded', async () => {
    const closed = await issue(1, [CHART, TOTAL], 'closed');
    await issue(2, [LEDGER], 'closed');
    await ok(supersede(closed, 1, { by: 'ISS-2', criterion: 1, reason: WHY }), 201);
    await ok(failOn(closed, 2), 201);
    await settleOutbox();
    expect(await statusOf(closed)).toBe('reopen');
  });

  it('reopens ISS-1 on a fail on criterion 1 when nothing superseded it (the regression it guards)', async () => {
    const closed = await issue(1, [CHART, TOTAL], 'closed');
    await ok(failOn(closed, 1), 201);
    await settleOutbox();
    expect(await statusOf(closed)).toBe('reopen');
  });
});
