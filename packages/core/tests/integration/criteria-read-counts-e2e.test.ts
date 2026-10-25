/**
 * The issue's criteria read says what a release counts (ISS-55 reopen void, REQ-74 BC-2 cutover).
 *
 * Planted from forge-dev catalog-api release 0.1.0: ISS-33's criteria passed at `ea74f277` on 10-23
 * 07:07, the issue was reopened at 07:13 and returned to awaiting_release with no new verdict. The
 * release roster voided those passes, while the criteria read marked each `countedUnderCutover: true`,
 * so two qa runs skipped exactly the criteria that were still open.
 *
 * @direct-test-of packages/core/src/issues/criteria/counting.ts
 */

import { randomUUID } from 'node:crypto';
import { UNRESOLVED_COMMIT_WHY } from '@forge/contracts/verified-rule';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { DEFAULT_POLICY } from '../../src/project-config/default-policy.js';
import { criteriaAt, loadReleaseFacts } from '../../src/release-batch/release-facts.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestRunSession,
  createTestUser,
  rows,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';

const BUILD = 'ea74f27700000000000000000000000000000000';
const BUILT = '2026-10-23T06:50:00Z';
const JUDGED = '2026-10-23T07:07:16Z';
const REOPENED = '2026-10-23T07:13:00Z';
const REJUDGED = '2026-10-25T07:18:12Z';
const VOID_WHY = 'recorded before the reopen on 2026-10-23 07:13 UTC; judge it again';

let projectId: string;
let token: string;
let builderBox: string;
let judgeBox: string;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function world() {
  await settleOutbox();
  await truncateAll();
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId, { policy: { ...DEFAULT_POLICY, qa: 'self' } })).id;
  token = await userToken(ownerId);
  builderBox = await createTestDevice(ownerId);
  judgeBox = await createTestDevice(ownerId);
  const { id } = await createTestIssue(projectId, ownerId, 33, {
    status: 'open',
    createdAt: new Date(BUILT),
    mergedAt: new Date(BUILT),
  });
  const put = await api(token, 'PUT', `/api/issues/${id}/criteria`, {
    criteria: [{ statement: 'A buyer sees the price' }, { statement: 'A buyer sees the stock' }],
  });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  // the building run's session on its box ran the issue's checks, so its verdicts are the builder's
  const runId = await createTestRunSession(projectId, builderBox, new Date(BUILT), null);
  const [s] = await rows<{ id: string }>(
    sql`SELECT id FROM agent_sessions WHERE pipeline_run_id = ${runId}`,
  );
  await db.execute(sql`
    INSERT INTO issue_check_runs (id, issue_id, kind, name, scope, command, result, duration_ms,
                                  started_at, head_sha, run_session_id, via, recorded_by)
    VALUES (${randomUUID()}, ${id}, 'tests', 'unit', 'core', 'pnpm test', 'pass', 1000,
            ${BUILT}, ${BUILD}, ${s?.id ?? null}, 'report', ${ownerId})`);
  await seedIssueStatus(id, 'awaiting_release');
  return id;
}

async function pass(issueId: string, n: number, at: string, device: string) {
  const res = await api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion: n,
    verdict: 'pass',
    reason: 'proved on the running build',
    identity: { kind: 'commit', sha: BUILD },
    evidence: ['shot.png'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await db.execute(
    sql`UPDATE criterion_verdicts SET created_at = ${at}, author_device_id = ${device} WHERE id = ${String(res.body.verdictId)}`,
  );
}

async function reopened(issueId: string) {
  await db.execute(sql`
    INSERT INTO kernel_transitions (id, entity, entity_id, from_status, to_status, actor_type, actor_agency, source, created_at)
    VALUES (${randomUUID()}, 'issue', ${issueId}, 'awaiting_release', 'reopen', 'user', 'human', 'test', ${REOPENED})`);
}

type Read = {
  criteria: {
    n: number;
    latest: { countedUnderCutover: boolean } | null;
    counts: { counted: boolean; why: string | null };
  }[];
};
const criteriaOf = async (issueId: string) => {
  const res = await api(token, 'GET', `/api/issues/${issueId}/criteria`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as unknown as Read).criteria;
};

async function roster(issueId: string, build: string | null = BUILD) {
  const facts = await loadReleaseFacts(projectId, [issueId], []);
  const issue = facts.issues.get(issueId);
  if (!issue) throw new Error('the release facts lost the issue');
  return criteriaAt(issue, build, facts.judge);
}

describe('the criteria read says whether a release counts each criterion', () => {
  it('counts the builder’s pass before a reopen only until the reopen, then says to judge it again', async () => {
    const issue = await world();
    await pass(issue, 1, JUDGED, builderBox);
    await pass(issue, 2, JUDGED, builderBox);

    // control: before any reopen the builder's pre-cutover pass counts, marked as the builder's
    const before = await criteriaOf(issue);
    expect(before.map((c) => c.counts)).toEqual([
      { counted: true, why: null },
      { counted: true, why: null },
    ]);
    expect(before[0]?.latest?.countedUnderCutover).toBe(true);
    expect((await roster(issue)).map((c) => c.proven)).toEqual([true, true]);

    await reopened(issue);
    await pass(issue, 2, REJUDGED, judgeBox);

    const after = await criteriaOf(issue);
    expect(after[0]?.counts).toEqual({ counted: false, why: VOID_WHY });
    expect(after[0]?.latest?.countedUnderCutover, 'a voided pass is never marked as counting').toBe(
      false,
    );
    expect(after[1]?.counts).toEqual({ counted: true, why: null });
    expect(after[1]?.latest?.countedUnderCutover, 'the judge’s pass is not the builder’s').toBe(
      false,
    );

    const release = await roster(issue);
    expect(release.map((c) => ({ proven: c.proven, unverified: c.unverified }))).toEqual([
      { proven: false, unverified: VOID_WHY },
      { proven: true, unverified: null },
    ]);
  });

  it('voids a pass recorded at the very instant of the reopen, and counts one a millisecond after', async () => {
    const issue = await world();
    await pass(issue, 1, REOPENED, builderBox);
    await pass(issue, 2, '2026-10-23T07:13:00.001Z', builderBox);
    await reopened(issue);

    expect((await criteriaOf(issue)).map((c) => c.counts.counted)).toEqual([false, true]);
    expect((await roster(issue)).map((c) => c.proven)).toEqual([false, true]);
  });

  it('counts no pass on a backfilled abbreviation, on the read as on a release with no cut build', async () => {
    const issue = await world();
    await pass(issue, 1, JUDGED, builderBox);
    await pass(issue, 2, JUDGED, judgeBox);
    await db.execute(sql`
      UPDATE criterion_verdicts v SET identity_kind = 'commit_unresolved', commit_sha = 'ea74f27', backfilled = true
        FROM issue_criteria c WHERE c.id = v.criterion_id AND c.issue_id = ${issue} AND c.n = 1`);

    const read = await criteriaOf(issue);
    expect(read[0]?.counts).toEqual({ counted: false, why: UNRESOLVED_COMMIT_WHY });
    expect(read[0]?.latest?.countedUnderCutover).toBe(false);
    expect(read[1]?.counts).toEqual({ counted: true, why: null });
    expect((await roster(issue, null)).map((c) => c.proven)).toEqual([false, true]);
  });
});
