/**
 * ISS-838 (FB-428, adminhub-api ISS-78, 2026-10-31): a judge and later a reviewer were declared on an
 * issue at `in_progress:test`, and each declaration dropped it to an earlier step nobody chose. A run
 * declared to judge takes the issue's lease but moves no step; a run that builds still starts the
 * step over at triage, the reading `issues/work-state.ts:restartStepsForNewRun` was written for.
 *
 * @direct-test-of packages/core/src/devices/run-take.ts
 * @direct-test-of packages/core/src/issues/work-state.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestUser,
} from '../helpers/factories.js';
import { projectBuiltFrom } from '../helpers/pattern-world.js';

let projectId = '';
let box = '';
const ids = new Map<number, string>();

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const admin = await createTestUser({ verified: true });
  projectId = await projectBuiltFrom(admin.id, null);
  await addProjectMember(projectId, admin.id, 'admin');
  const deviceId = await createTestDevice(admin.id);
  await bindTestRunner(projectId, deviceId);
  box = (
    await mintPat({
      permissions: ['*'],
      userId: admin.id,
      name: 'box-judge-step',
      deviceId,
      projectIds: [projectId],
    })
  ).plaintext;
  for (const seq of [1, 2, 3, 4, 5]) {
    const issue = await createTestIssue(projectId, admin.id, seq, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    ids.set(seq, issue.id);
    await db.execute(sql`
      INSERT INTO issue_work_state (issue_id, step, step_started_at, updated_at)
      VALUES (${issue.id}, 'test', now() - interval '1 hour', now())`);
  }
  const master = await api(box, 'POST', '/api/devices/me/master-session', {
    projectId,
    name: 'forge-master-step',
    maxJobPanes: 3,
  });
  expect([master.status, JSON.stringify(master.body)]).toEqual([200, expect.any(String)]);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const declare = (runId: string, issueKeys: string[], role?: string) =>
  api(box, 'POST', '/api/devices/me/run-sessions', {
    projectId,
    runId,
    issueKeys,
    name: `${role ?? 'run'}-${runId.slice(0, 4)}`,
    ...(role ? { role } : {}),
  });
const close = (sessionId: string) =>
  api(box, 'POST', `/api/devices/me/run-sessions/${sessionId}/close`, { outcome: 'ended' });
const codes = (body: unknown): string[] =>
  (((body as Doc).error?.refusals ?? []) as Doc[]).map((r) => String(r.code));

async function stepOf(seq: number): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT step FROM issue_work_state WHERE issue_id = ${ids.get(seq)}`)) as unknown as Array<{
    step: string | null;
  }>;
  return rows[0]?.step ?? null;
}

async function leaseHeld(key: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM issue_leases WHERE project_id = ${projectId} AND issue_key = ${key}`)) as unknown as Array<{
    n: number;
  }>;
  return (rows[0]?.n ?? 0) > 0;
}

describe('ISS-838 a run declared on an issue at in_progress:test', () => {
  it.each([
    [1, 'qa'],
    [2, 'reviewer'],
    [3, 'forge:reviewer'],
  ])('ISS-%i: a %s run takes the lease and leaves the step at test', async (seq, role) => {
    const key = `ISS-${seq}`;
    const res = await declare(randomUUID(), [key], role);
    expect([res.status, codes(res.body)]).toEqual([200, []]);
    expect(await leaseHeld(key), 'a judging run still holds the issue it judges').toBe(true);
    expect(await stepOf(seq), `a ${role} declaration moved the step`).toBe('test');
    await close(String((res.body as Doc).sessionId));
    expect(await stepOf(seq), `closing the ${role} run moved the step`).toBe('test');
  });

  it('a building run still starts the step over at triage', async () => {
    const res = await declare(randomUUID(), ['ISS-4'], 'runner');
    expect([res.status, codes(res.body)]).toEqual([200, []]);
    expect(await stepOf(4)).toBe('triage');
    await close(String((res.body as Doc).sessionId));
  });

  it('a qa run queued behind a builder keeps the step when it is admitted', async () => {
    const builder = await declare(randomUUID(), ['ISS-5'], 'runner');
    expect([builder.status, codes(builder.body)]).toEqual([200, []]);
    await db.execute(sql`
      UPDATE issue_work_state SET step = 'test', step_started_at = now() WHERE issue_id = ${ids.get(5)}`);

    const judgeRun = randomUUID();
    const queued = await declare(judgeRun, ['ISS-5'], 'qa');
    expect(codes(queued.body)).toEqual(['ISSUE_LEASE_HELD']);
    expect(await stepOf(5), 'a refused declaration moved the step').toBe('test');

    await close(String((builder.body as Doc).sessionId));
    const admitted = await declare(judgeRun, ['ISS-5'], 'qa');
    expect([admitted.status, codes(admitted.body)]).toEqual([200, []]);
    expect(await leaseHeld('ISS-5')).toBe(true);
    expect(await stepOf(5), 'admitting the queued qa run moved the step').toBe('test');
    await close(String((admitted.body as Doc).sessionId));
  });
});
