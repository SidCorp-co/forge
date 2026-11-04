/**
 * ISS-951: an issue a master's in-pane builder took read `Triage · 1h45m` after it was built, checked
 * and landed (ISS-933, ISS-934 on forge-dev, 2026-11-04): the claim wrote `triage`, and no writer
 * after it named a step. What core records about the work now moves the step forward, never back,
 * and only while the issue is in progress; each move tells the project's room.
 *
 * @direct-test-of packages/core/src/issues/work-state.ts
 * @direct-test-of packages/core/src/issues/update-service.ts
 * @direct-test-of packages/core/src/issues/merge-record.ts
 * @direct-test-of packages/core/src/issues/merge-check.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

let projectId = '';
let ownerId = '';
let token = '';
let seq = 0;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** An issue at `status`, its step `triage` since the claim an hour and three quarters ago. */
async function claimed(status = 'in_progress'): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`step ${seq}`}, ${status}, ${ownerId})`);
  await db.execute(sql`
    INSERT INTO issue_work_state (issue_id, step, step_started_at, steps, updated_at)
    VALUES (${id}, 'triage', now() - interval '105 minutes',
            jsonb_build_array(jsonb_build_object('step', 'triage', 'startedAt', (now() - interval '105 minutes')::text, 'endedAt', null)),
            now())`);
  return id;
}

async function stepOf(id: string): Promise<{ step: string | null; log: string[] }> {
  const rows = (await db.execute(sql`
    SELECT step, steps FROM issue_work_state WHERE issue_id = ${id}`)) as unknown as Array<{
    step: string | null;
    steps: Array<{ step: string }>;
  }>;
  return { step: rows[0]?.step ?? null, log: (rows[0]?.steps ?? []).map((s) => s.step) };
}

async function stepFrames(): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM pipeline_outbox
     WHERE type = 'session.pushed'
       AND payload->>'event' = 'project.now.changed'
       AND payload->'data'->>'source' = 'step'
       AND payload->>'projectId' = ${projectId}`)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

async function mark(id: string): Promise<void> {
  const { recordIssueMerge } = await import('../../src/issues/index.js');
  await db.transaction((tx) =>
    recordIssueMerge(tx, {
      issueId: id,
      evidence: { kind: 'asserted' },
      actor: { type: 'user', id: ownerId, agency: 'human' } as never,
      via: 'mark',
    }),
  );
}

describe('ISS-951 the step follows what core records about the work', () => {
  it('a stale triage is replaced by plan when a plan is written, then by test when the work is marked merged', async () => {
    const id = await claimed();
    const framesBefore = await stepFrames();

    const planned = await api(token, 'PATCH', `/api/issues/${id}`, {
      plan: '1. build it\n2. prove it',
    });
    expect([planned.status, JSON.stringify(planned.body).slice(0, 300)]).toEqual([
      200,
      expect.any(String),
    ]);
    expect((await stepOf(id)).step, 'a written plan left the claim step standing').toBe('plan');

    await mark(id);
    const after = await stepOf(id);
    expect(after.step, 'a merge mark left the step before test').toBe('test');
    expect(after.log, 'each move is a step of the log, oldest first').toEqual([
      'triage',
      'plan',
      'test',
    ]);
    expect(await stepFrames(), 'each move tells the project room').toBe(framesBefore + 2);
  });

  it('evidence never moves a step back', async () => {
    const id = await claimed();
    await db.execute(sql`
      UPDATE issue_work_state SET step = 'test', step_started_at = now() WHERE issue_id = ${id}`);
    const framesBefore = await stepFrames();
    const planned = await api(token, 'PATCH', `/api/issues/${id}`, { plan: 'a revised plan' });
    expect(planned.status).toBe(200);
    expect((await stepOf(id)).step, 'a plan rewritten at test dropped the step back').toBe('test');
    expect(await stepFrames(), 'a step that did not move told the room it moved').toBe(
      framesBefore,
    );
  });

  it('an issue that is not in progress takes no step from evidence', async () => {
    const id = await claimed('open');
    await db.execute(
      sql`UPDATE issue_work_state SET step = NULL, step_started_at = NULL, steps = '[]'::jsonb WHERE issue_id = ${id}`,
    );
    const planned = await api(token, 'PATCH', `/api/issues/${id}`, {
      plan: 'planned before anyone took it',
    });
    expect(planned.status).toBe(200);
    expect((await stepOf(id)).step, 'an open issue was given a run step').toBeNull();
  });

  it('a write naming its own step is not overridden by the plan it carries', async () => {
    const id = await claimed();
    const written = await api(token, 'PATCH', `/api/issues/${id}`, {
      plan: 'clarify first',
      workState: { step: 'clarify' },
    });
    expect([written.status, JSON.stringify(written.body).slice(0, 300)]).toEqual([
      200,
      expect.any(String),
    ]);
    expect((await stepOf(id)).step).toBe('clarify');
  });

  it('a blank plan is no evidence of planning', async () => {
    const id = await claimed();
    const blank = await api(token, 'PATCH', `/api/issues/${id}`, { plan: '   ' });
    expect(blank.status).toBeLessThan(500);
    expect((await stepOf(id)).step).toBe('triage');
  });
});
