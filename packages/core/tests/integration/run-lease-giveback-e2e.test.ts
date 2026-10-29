/**
 * ISS-752: a run's close gave back every lease its box held on an issue key, not only the leases
 * that run took. Planted from ISS-572 on dev, 2026-10-29: a judge run over the closed ISS-572 (which
 * takes no lease) and the ISS-572 r2 run (which took one when the issue reopened) shared a box. The
 * judge closed 0.4 s after r2 opened; the box's close loop asked whether the box still held ISS-572,
 * read r2's lease, and gave it back. Core removed r2's lease row and took ISS-572 out of r2's issue
 * list, and r2's own move to in_progress was then refused NO_HOLDER.
 *
 * A give-back now names the run session giving back (`?sessionId=`), and core removes only that
 * session's lease and strips the key only from that lease's run. A give-back naming no session is
 * the shape an installed runner still sends: it removes a lease whose session has ended and refuses
 * one whose session is live, `ISSUE_LEASE_RUN_UNNAMED`, removing nothing.
 *
 * @direct-test-of packages/core/src/issues/issue-lease.ts
 * @direct-test-of packages/core/src/issues/issue-lease-read.ts
 * @direct-test-of packages/core/src/devices/run-session.ts
 * @direct-test-of packages/core/src/devices/pool-routes.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

const world = { projectId: '', ownerId: '', owner: '', box: '', boxPat: '', otherPat: '' };

async function boxPat(userId: string, deviceId: string): Promise<string> {
  const { mintPat } = await import('../../src/credentials/pat.js');
  return (
    await mintPat({
      permissions: ['*'],
      userId,
      name: `workspace:${deviceId}:${world.projectId}`,
      deviceId,
      projectIds: [world.projectId],
      onBehalfOf: world.ownerId,
    })
  ).plaintext;
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.owner = await userToken(world.ownerId);
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(world.projectId, agent, 'member');
  world.box = await createTestDevice(world.ownerId);
  const other = await createTestDevice(world.ownerId);
  await bindTestRunner(world.projectId, world.box);
  await bindTestRunner(world.projectId, other);
  world.boxPat = await boxPat(agent, world.box);
  world.otherPat = await boxPat(agent, other);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const codeOf = (body: unknown): string | null => {
  const b = body as { error?: { code?: string; refusals?: Array<{ code: string }> } };
  return b.error?.refusals?.[0]?.code ?? b.error?.code ?? null;
};

interface Run {
  runId: string;
  sessionId: string;
}

async function open(key: string, token: string = world.boxPat): Promise<Run> {
  const boxRunId = randomUUID();
  const res = await api(token, 'POST', '/api/devices/me/run-sessions', {
    projectId: world.projectId,
    runId: boxRunId,
    issueKeys: [key],
    name: `run-${key}-${boxRunId.slice(0, 8)}`,
  });
  expect([res.status, codeOf(res.body)], JSON.stringify(res.body)).toEqual([200, null]);
  const body = res.body as Doc;
  return { runId: String(body.runId), sessionId: String(body.sessionId) };
}

async function endRun(sessionId: string, token: string = world.boxPat): Promise<void> {
  const ended = await api(token, 'POST', `/api/devices/me/run-sessions/${sessionId}/close`, {
    outcome: 'ended',
  });
  expect(ended.status, JSON.stringify(ended.body)).toBe(200);
}

/** The lease rows standing on a key, as [session_id, run_id]. */
async function leaseRows(key: string): Promise<string[][]> {
  const rows = (await db.execute(sql`
    SELECT session_id, run_id FROM issue_leases
     WHERE project_id = ${world.projectId} AND issue_key = ${key}`)) as unknown as Array<{
    session_id: string;
    run_id: string;
  }>;
  return rows.map((r) => [String(r.session_id), String(r.run_id)]);
}

async function runIssues(runId: string): Promise<string[]> {
  const [row] = (await db.execute(sql`
    SELECT metadata -> 'runIssues' AS issues FROM pipeline_runs WHERE id = ${runId}`)) as unknown as Array<{
    issues: string[] | null;
  }>;
  return row?.issues ?? [];
}

const leasePath = (key: string, sessionId?: string): string =>
  `/api/devices/me/issue-leases/${key}?projectId=${world.projectId}${sessionId ? `&sessionId=${sessionId}` : ''}`;

const move = (token: string, issueId: string, toStatus: string) =>
  api(token, 'POST', `/api/issues/${issueId}/transition`, {
    toStatus,
    reason: 'a judge failed a criterion on the release that carried it',
  });

/** ISS-572's shape: a judge over the closed issue (no lease), the issue reopens, a run takes it. */
async function judgeThenRun(
  seq: number,
): Promise<{ id: string; key: string; judge: Run; run: Run }> {
  const issue = await createTestIssue(world.projectId, world.ownerId, seq, {
    status: 'closed',
    createdAt: new Date(),
    mergedAt: new Date(),
  });
  const judge = await open(issue.key);
  expect(await leaseRows(issue.key), 'a run over a closed issue took a fleet lease').toEqual([]);
  const reopened = await move(world.owner, issue.id, 'reopen');
  expect([reopened.status, codeOf(reopened.body)], JSON.stringify(reopened.body)).toEqual([
    200,
    null,
  ]);
  const run = await open(issue.key);
  expect(await leaseRows(issue.key)).toEqual([[run.sessionId, run.runId]]);
  await endRun(judge.sessionId);
  return { ...issue, judge, run };
}

describe('ISS-752 a give-back removes only the lease of the run giving it back', () => {
  it('criterion 1: the older run closing beside a newer one leaves its lease, its list, and its move', async () => {
    const { id, key, judge, run } = await judgeThenRun(1);

    // An installed runner's give-back names no run: a live run's lease is not its to take.
    const unnamed = await api(world.boxPat, 'DELETE', leasePath(key));
    expect(await leaseRows(key), 'the newer run lost its lease').toEqual([
      [run.sessionId, run.runId],
    ]);
    expect(await runIssues(run.runId), "the key left the newer run's issue list").toContain(key);
    expect([unnamed.status, codeOf(unnamed.body)], JSON.stringify(unnamed.body)).toEqual([
      409,
      'ISSUE_LEASE_RUN_UNNAMED',
    ]);
    expect(JSON.stringify(unnamed.body)).toContain(run.sessionId);

    // The box's close loop for the judge: the read-back, then the give-back, both naming its run.
    const read = await api(world.boxPat, 'GET', leasePath(key, judge.sessionId));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect((read.body as Doc).heldByThisSession).toBe(false);
    expect((read.body as Doc).heldByThisDevice).toBe(true);
    const named = await api(world.boxPat, 'DELETE', leasePath(key, judge.sessionId));
    expect([named.status, codeOf(named.body)], JSON.stringify(named.body)).toEqual([
      404,
      'ISSUE_LEASE_NOT_HELD',
    ]);
    expect(await leaseRows(key)).toEqual([[run.sessionId, run.runId]]);
    expect(await runIssues(run.runId)).toContain(key);

    const taken = await move(world.boxPat, id, 'in_progress');
    expect([taken.status, codeOf(taken.body)], JSON.stringify(taken.body)).toEqual([200, null]);
  });

  it("criterion 1 boundary: a session another box opened reaches nothing on this box's give-back", async () => {
    const issue = await createTestIssue(world.projectId, world.ownerId, 2, {
      status: 'open',
      createdAt: new Date(),
    });
    const run = await open(issue.key);
    const res = await api(world.otherPat, 'DELETE', leasePath(issue.key, run.sessionId));
    expect([res.status, codeOf(res.body)], JSON.stringify(res.body)).toEqual([
      404,
      'ISSUE_LEASE_NOT_HELD',
    ]);
    expect(await leaseRows(issue.key)).toEqual([[run.sessionId, run.runId]]);
  });

  it('criterion 2: a run giving back its own lease leaves no lease of it and drops the key from its list', async () => {
    const issue = await createTestIssue(world.projectId, world.ownerId, 3, {
      status: 'open',
      createdAt: new Date(),
    });
    const run = await open(issue.key);
    const before = await api(world.boxPat, 'GET', leasePath(issue.key, run.sessionId));
    expect((before.body as Doc).heldByThisSession).toBe(true);

    const res = await api(world.boxPat, 'DELETE', leasePath(issue.key, run.sessionId));
    expect([res.status, codeOf(res.body)], JSON.stringify(res.body)).toEqual([200, null]);
    expect(await leaseRows(issue.key)).toEqual([]);
    expect(await runIssues(run.runId)).not.toContain(issue.key);
    const after = await api(world.boxPat, 'GET', leasePath(issue.key, run.sessionId));
    expect([(after.body as Doc).heldByThisSession, (after.body as Doc).held]).toEqual([
      false,
      false,
    ]);
  });

  it('criterion 2: a give-back naming no run still returns a lease whose run session has ended', async () => {
    const issue = await createTestIssue(world.projectId, world.ownerId, 4, {
      status: 'open',
      createdAt: new Date(),
    });
    const run = await open(issue.key);
    await endRun(run.sessionId);
    const res = await api(world.boxPat, 'DELETE', leasePath(issue.key));
    expect([res.status, codeOf(res.body)], JSON.stringify(res.body)).toEqual([200, null]);
    expect(await leaseRows(issue.key)).toEqual([]);
    expect(await runIssues(run.runId)).not.toContain(issue.key);
  });

  it('a read naming no session answers heldByThisSession null, the device question unchanged', async () => {
    const issue = await createTestIssue(world.projectId, world.ownerId, 5, {
      status: 'open',
      createdAt: new Date(),
    });
    await open(issue.key);
    const res = await api(world.boxPat, 'GET', leasePath(issue.key));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as Doc;
    expect([body.held, body.heldByThisDevice, body.heldByThisSession]).toEqual([true, true, null]);
  });
});
