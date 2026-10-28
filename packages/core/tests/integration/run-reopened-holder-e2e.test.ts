/**
 * ISS-589 (REQ-2 BC-3): a run declared over an issue that is closed takes no fleet lease
 * (`devices/run-session.ts:declaredOverClosedWork`, ISS-576), so when the issue reopened under it,
 * the in_progress guard read nothing holding it and refused NO_HOLDER while runs/standing named that
 * run's live session the holder. Planted from ISS-605 r2 on dev, 2026-10-24: its fix round landed,
 * and the issue could not leave reopen while runs/standing named run a366da21 its holder. Every
 * holder read now counts the run sessions declared over the issue (`issues/issue-lease.ts:
 * runSessionsDeclaredOverSql`, the relation `issueRunDeclaredSql` reads), so the guard, the
 * awaiting_release guard and the standing name one holder; an ended session still holds nothing.
 *
 * The boxes' credentials are an agent account with the member role, as a box's is: neither holds
 * `releases.approve` nor `project.admin`, so only being the holder lets a move through.
 *
 * @direct-test-of packages/core/src/issues/issue-lease.ts
 * @direct-test-of packages/core/src/issues/run-holder.ts
 * @direct-test-of packages/core/src/issues/work-state.ts
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

const SHA = '58'.repeat(20);

const world = {
  projectId: '',
  ownerId: '',
  owner: '',
  box: '',
  boxPat: '',
  other: '',
  otherPat: '',
};

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
  world.other = await createTestDevice(world.ownerId);
  await bindTestRunner(world.projectId, world.box);
  await bindTestRunner(world.projectId, world.other);
  world.boxPat = await boxPat(agent, world.box);
  world.otherPat = await boxPat(agent, world.other);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const codeOf = (body: unknown): string | null => {
  const b = body as { error?: { code?: string; refusals?: Array<{ code: string }> } };
  return b.error?.refusals?.[0]?.code ?? b.error?.code ?? null;
};

/** A closed issue whose work landed: what a release judge is declared over. */
async function closedIssue(seq: number): Promise<{ id: string; key: string }> {
  return createTestIssue(world.projectId, world.ownerId, seq, {
    status: 'closed',
    createdAt: new Date(),
    mergedAt: new Date(),
  });
}

/** The master's run over `key`, opened by the box: a run over closed work, so it takes nothing. */
async function declared(key: string): Promise<{ runId: string; sessionId: string }> {
  const runId = randomUUID();
  const res = await api(world.boxPat, 'POST', '/api/devices/me/run-sessions', {
    projectId: world.projectId,
    runId,
    issueKeys: [key],
    name: `judge-${key}`,
  });
  expect([res.status, codeOf(res.body)], JSON.stringify(res.body)).toEqual([200, null]);
  const leases = (await db.execute(sql`
    SELECT count(*)::int AS n FROM issue_leases
     WHERE project_id = ${world.projectId} AND issue_key = ${key}`)) as unknown as Array<{
    n: number;
  }>;
  expect(leases[0]?.n, 'a run over a closed issue took a fleet lease').toBe(0);
  return { runId, sessionId: String((res.body as Doc).sessionId) };
}

const move = (token: string, issueId: string, toStatus: string) =>
  api(token, 'POST', `/api/issues/${issueId}/transition`, {
    toStatus,
    reason: 'a judge failed a criterion on the release that carried it',
  });

async function reopened(issueId: string): Promise<void> {
  const res = await move(world.owner, issueId, 'reopen');
  expect([res.status, codeOf(res.body)], JSON.stringify(res.body)).toEqual([200, null]);
}

async function statusOf(issueId: string): Promise<string | undefined> {
  const [row] = (await db.execute(
    sql`SELECT status FROM issues WHERE id = ${issueId}`,
  )) as unknown as Array<{ status: string }>;
  return row?.status;
}

describe('ISS-589 a run declared over a closed issue holds it once it reopens', () => {
  it('criterion 1: the reopened issue moves to in_progress under that run, no NO_HOLDER', async () => {
    const issue = await closedIssue(1);
    await declared(issue.key);
    await reopened(issue.id);

    const taken = await move(world.boxPat, issue.id, 'in_progress');
    expect([taken.status, codeOf(taken.body)], JSON.stringify(taken.body)).toEqual([200, null]);
    expect(await statusOf(issue.id)).toBe('in_progress');
  });

  it('criterion 2: a run session that has ended holds nothing, and NO_HOLDER stands', async () => {
    const issue = await closedIssue(2);
    const run = await declared(issue.key);
    const ended = await api(
      world.boxPat,
      'POST',
      `/api/devices/me/run-sessions/${run.sessionId}/close`,
      { outcome: 'ended' },
    );
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    await reopened(issue.id);

    const refused = await move(world.boxPat, issue.id, 'in_progress');
    expect([refused.status, codeOf(refused.body)], JSON.stringify(refused.body)).toEqual([
      409,
      'NO_HOLDER',
    ]);
    expect(await statusOf(issue.id)).toBe('reopen');
  });

  it('criterion 3: runs/standing and the guards name one holder, and its box makes the move', async () => {
    const issue = await closedIssue(3);
    const run = await declared(issue.key);
    await reopened(issue.id);

    const standing = await api(
      world.owner,
      'GET',
      `/api/projects/${world.projectId}/runs/standing/${run.runId}`,
    );
    expect(standing.status, JSON.stringify(standing.body)).toBe(200);
    const holder = ((standing.body as Doc).run as Doc).holder as Doc;
    expect([holder.source, holder.sessionId]).toEqual(['held', run.sessionId]);

    expect((await move(world.boxPat, issue.id, 'in_progress')).status).toBe(200);
    await db.execute(
      sql`UPDATE issues SET merged_at = now(), merged_commit_sha = ${SHA} WHERE id = ${issue.id}`,
    );

    const refused = await move(world.otherPat, issue.id, 'awaiting_release');
    expect([refused.status, codeOf(refused.body)], JSON.stringify(refused.body)).toEqual([
      403,
      'NOT_THE_HOLDER',
    ]);
    const named = ((refused.body as Doc).error?.refusals?.[0]?.holders ?? []) as Doc[];
    expect(named.map((h) => [h.kind, h.sessionId, h.deviceId])).toEqual([
      ['run-session', holder.sessionId, world.box],
    ]);

    const released = await move(world.boxPat, issue.id, 'awaiting_release');
    expect([released.status, codeOf(released.body)], JSON.stringify(released.body)).toEqual([
      200,
      null,
    ]);
    expect(await statusOf(issue.id)).toBe('awaiting_release');
  });
});
