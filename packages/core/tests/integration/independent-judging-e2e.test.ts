/**
 * ISS-683 (REQ-74 BC-2, BC-3; absorbs ISS-475 and ISS-598): each criterion is judged by someone other
 * than its builder, and a failing verdict reopens the issue that owns the work, never a new one.
 *
 * Planted from forge-dev: release 0.4.0-dev.307 read judge K72's ten passes on ISS-588/576/590/568 as
 * "passed by the run that built it", because the judge's run, declared over the issues at
 * `awaiting_release`, held their leases on the master's box (`issues/built-by.ts`); under `qa: self`
 * on hop, epod, adminhub and catalog the building run's own pass counted; and judge K6's fail on
 * ISS-562 c3 after release 0.4.0-dev.265 closed it left the issue closed until the master reopened it
 * by hand (ISS-598).
 *
 * @direct-test-of packages/core/src/issues/built-by.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { DEFAULT_POLICY } from '../../src/project-config/default-policy.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestRunSession,
  createTestUser,
  makeAgreeReady,
  rows,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';

const NEW = '2222222222222222222222222222222222222222';
const LIVE = '9999999999999999999999999999999999999999';
const BUILT = '2026-10-04T10:00:00Z';
const JUDGED = '2026-10-05T10:00:00Z';
const BUILDER_WHY = "passed by the run that built it, and a builder's own pass never counts";

let projectId: string;
let ownerId: string;
let token: string;
let box: string;
let unplant: (() => void) | null = null;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function world(qa: 'self' | 'independent') {
  await settleOutbox();
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId, { policy: { ...DEFAULT_POLICY, qa } })).id;
  token = await userToken(ownerId);
  box = await createTestDevice(ownerId);
}

beforeEach(() => {
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
      title: 'Reminders',
      reason: 'planted',
      criteria: [{ body: 'A nurse sees the reminder' }, { body: 'A doctor sees the report' }],
    }),
  );
  const key = String(created.key);
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  await ok(onProject('POST', `/requirements/${key}/revisions/1/propose`, {}));
  await ok(onProject('POST', `/requirements/${key}/revisions/1/accept`, {}));
  await ok(
    onProject('POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Agreed with the owner for this test.',
    }),
  );
  return key;
}

/** Issue `seq` at `status` delivering `req`, tied to `codes`, landed where it is past its build. */
async function issueTracing(
  req: string,
  seq: number,
  codes: string[],
  status: 'closed' | 'awaiting_release' | 'in_progress' | 'open' = 'closed',
): Promise<string> {
  const landed = status === 'closed' || status === 'awaiting_release';
  const { id } = await createTestIssue(projectId, ownerId, seq, {
    status: 'open',
    createdAt: new Date(),
    mergedAt: landed ? new Date() : null,
  });
  await ok(onProject('POST', `/requirements/${req}/issues`, { issue: `ISS-${seq}` }));
  await ok(api(token, 'POST', `/api/issues/${id}/criteria/traces`, { codes }));
  if (status !== 'open') await seedIssueStatus(id, status);
  return id;
}

/** A verdict on criterion `n` of `issueId` at NEW, stamped at `at` from `device`. */
async function judge(
  issueId: string,
  n: number,
  verdict: 'pass' | 'fail',
  at: string,
  device: string | null,
) {
  const res = await api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion: n,
    verdict,
    reason: `${verdict} on the running build`,
    identity: { kind: 'commit', sha: NEW },
    evidence: ['shot.png'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await db.execute(
    sql`UPDATE criterion_verdicts SET created_at = ${at}, author_device_id = ${device} WHERE id = ${String(res.body.verdictId)}`,
  );
  return res.body;
}

/** A run session on `device` from BUILT, declared over `declared` (issue key -> status at open). */
async function runOn(declared: Record<string, string> | null): Promise<string> {
  const runId = await createTestRunSession(projectId, box, new Date(BUILT), null);
  if (declared) {
    await db.execute(sql`
      UPDATE pipeline_runs SET metadata = ${JSON.stringify({ type: 'run_session', runGroup: Object.keys(declared), runIssueStatuses: declared })}::jsonb
       WHERE id = ${runId}`);
  }
  const [s] = await rows<{ id: string }>(
    sql`SELECT id FROM agent_sessions WHERE pipeline_run_id = ${runId}`,
  );
  if (!s) throw new Error('no run session seeded');
  return s.id;
}

async function lease(key: string, session: string) {
  await db.execute(sql`
    INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
    SELECT ${projectId}, ${key}, ${box}, id, pipeline_run_id FROM agent_sessions WHERE id = ${session}
    ON CONFLICT (project_id, issue_key) DO UPDATE
      SET session_id = EXCLUDED.session_id, run_id = EXCLUDED.run_id, device_id = EXCLUDED.device_id`);
}

async function checked(issueId: string, session: string | null) {
  await db.execute(sql`
    INSERT INTO issue_check_runs (id, issue_id, kind, name, scope, command, result, duration_ms,
                                  started_at, head_sha, run_session_id, via, recorded_by)
    VALUES (${randomUUID()}, ${issueId}, 'tests', 'unit', 'core', 'pnpm test', 'pass', 1000,
            ${BUILT}, ${NEW}, ${session}, 'report', ${ownerId})`);
}

type Bc = { code: string; verdict: string; issues: { notCounted: string | null }[] };
const bc = async (req: string, code: string) => {
  const d = (await ok(onProject('GET', `/requirements/${req}`))) as {
    standing: { coverage: Bc[] };
  };
  return d.standing.coverage.find((c) => c.code === code) as Bc;
};

async function statusOf(issueId: string): Promise<string> {
  await settleOutbox();
  const [row] = await rows<{ status: string }>(
    sql`SELECT status FROM issues WHERE id = ${issueId}`,
  );
  return row?.status ?? 'missing';
}

describe('BC-2: a pass by the run that built the work never counts, whatever qa says', () => {
  it('does not count the building run’s own pass under qa: self, and says why', async () => {
    await world('self');
    const req = await agreedRequirement();
    const issue = await issueTracing(req, 1, ['BC-1']);
    await checked(issue, await runOn({ 'ISS-1': 'in_progress' }));
    await judge(issue, 1, 'pass', JUDGED, box);

    const one = await bc(req, 'BC-1');
    expect(one.verdict).toBe('not_judged');
    expect(one.issues[0]?.notCounted).toBe(BUILDER_WHY);
  });

  it('does not count the builder’s pass once a judge took its lease, by the run it was declared over', async () => {
    await world('independent');
    const req = await agreedRequirement();
    const issue = await issueTracing(req, 1, ['BC-1']);
    const builder = await runOn({ 'ISS-1': 'in_progress' });
    await lease('ISS-1', builder);
    await judge(issue, 1, 'pass', JUDGED, box);
    await lease('ISS-1', await runOn({ 'ISS-1': 'awaiting_release' }));

    expect((await bc(req, 'BC-1')).verdict).toBe('not_judged');
  });

  it('counts judge K72’s pass: a run declared over the issue at awaiting_release built nothing', async () => {
    await world('independent');
    const req = await agreedRequirement();
    const issue = await issueTracing(req, 1, ['BC-1'], 'awaiting_release');
    const judgeRun = await runOn({ 'ISS-1': 'awaiting_release' });
    await lease('ISS-1', judgeRun);
    await judge(issue, 1, 'pass', JUDGED, box);

    expect((await bc(req, 'BC-1')).verdict).toBe('passing');
  });

  it('answers the builder’s pass as not counted on the verdict write itself, never a silent 201', async () => {
    await world('self');
    const req = await agreedRequirement();
    const issue = await issueTracing(req, 1, ['BC-1'], 'in_progress');
    // the account recorded its checks from no box, so a verdict it sends from no box is the builder's
    await checked(issue, null);

    const res = await api(token, 'POST', `/api/issues/${issue}/verdicts`, {
      criterion: 1,
      verdict: 'pass',
      reason: 'proved by running it',
      identity: { kind: 'commit', sha: NEW },
      evidence: ['probe.log'],
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.notCounted).toMatchObject({ code: 'VERDICT_BY_BUILDER' });
  });
});

describe('BC-3: a failing verdict reopens the issue that owns the work', () => {
  beforeEach(() => world('independent'));

  it('reopens an issue awaiting release on a fail, naming the criterion', async () => {
    const req = await agreedRequirement();
    const issue = await issueTracing(req, 1, ['BC-1'], 'awaiting_release');
    await judge(issue, 1, 'fail', JUDGED, null);

    expect(await statusOf(issue)).toBe('reopen');
    const [said] = await rows<{ body: string }>(sql`
      SELECT body FROM comments WHERE issue_id = ${issue} ORDER BY created_at DESC LIMIT 1`);
    expect(said?.body).toContain('criterion 1');
  });

  it('reopens a closed issue on a fail, as ISS-562 was not', async () => {
    const req = await agreedRequirement();
    const issue = await issueTracing(req, 1, ['BC-1']);
    await judge(issue, 1, 'fail', JUDGED, null);

    expect(await statusOf(issue)).toBe('reopen');
  });

  it('leaves a closed issue closed on a pass, and a building one where it is on a fail', async () => {
    const req = await agreedRequirement();
    const closed = await issueTracing(req, 1, ['BC-1']);
    const building = await issueTracing(req, 2, ['BC-2'], 'in_progress');
    await judge(closed, 1, 'pass', JUDGED, null);
    await judge(building, 1, 'fail', JUDGED, null);

    expect(await statusOf(closed)).toBe('closed');
    expect(await statusOf(building)).toBe('in_progress');
  });

  it('sends a requirement-level fail to the issue that delivered the criterion', async () => {
    const req = await agreedRequirement();
    const issue = await issueTracing(req, 1, ['BC-1']);

    const res = await onProject('POST', `/requirements/${req}/verdicts`, {
      criterion: 'BC-1',
      verdict: 'fail',
      reason: 'the nurse saw no reminder on the running build',
      identity: { kind: 'commit', sha: NEW },
      evidence: ['shot.png'],
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.owner).toMatchObject({ key: 'ISS-1' });
    expect(await statusOf(issue)).toBe('reopen');
  });

  it('refuses tracing a new issue to a failing criterion another issue owns, naming the owner', async () => {
    const req = await agreedRequirement();
    const owner = await issueTracing(req, 1, ['BC-1']);
    await judge(owner, 1, 'fail', JUDGED, null);
    await statusOf(owner);
    const { id } = await createTestIssue(projectId, ownerId, 2, {
      status: 'open',
      createdAt: new Date(),
    });
    await ok(onProject('POST', `/requirements/${req}/issues`, { issue: 'ISS-2' }));

    const res = await api(token, 'POST', `/api/issues/${id}/criteria/traces`, { codes: ['BC-1'] });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const said = JSON.stringify(res.body);
    expect(said).toContain('CRITERION_FAILURE_OWNED');
    expect(said).toContain('ISS-1');

    expect(
      (await api(token, 'POST', `/api/issues/${id}/criteria/traces`, { codes: ['BC-2'] })).status,
    ).toBeLessThan(300);
  });
});
