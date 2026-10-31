/**
 * ISS-814 (REQ-79 BC-9): a cleanup fire ends with its report posted or failed, naming the gap. The
 * session a fire starts is completed through the session machine, as a box ending its turn does,
 * and the fire's settlement is read back.
 *
 * @direct-test-of packages/core/src/schedules/fires.ts
 */

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { transitionSessions } from '../../src/agent-sessions/index.js';
import { db } from '../../src/db/client.js';
import { agentSessions } from '../../src/db/schema.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';

let projectId: string;
let token: string;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
});

const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const res = await api(token, method, path, body);
  return { status: res.status, body: res.body as Doc };
};
const codes = (res: { body: Doc }): string[] =>
  (res.body.error?.refusals ?? []).map((r: Doc) => r.code);
const red = (rating: 'low' | 'medium' | 'high') => ({
  kind: 'red',
  check: 'verify',
  where: 'scripts/check-copy-budget.mjs',
  detail: 'copy budget over by 12 lines',
  impact: { type: 'config', rating, reason: 'a budget gate, the app is untouched' },
});
const debts = (body: unknown) => call('POST', `/api/projects/${projectId}/debts`, body);
const ledger = () => call('GET', `/api/projects/${projectId}/debts`);
const reportCleanup = (body: Doc) =>
  call('POST', `/api/projects/${projectId}/cleanup-reports`, {
    base: { branch: 'dev', sha: 'c'.repeat(40) },
    result: 'green',
    cleared: [],
    remains: [],
    ...body,
  });

// ISS-814 (fire d496a69e, 2026-10-30): a cleanup session ended its turn "waiting on the merge check",
// completed, and its fire read `success` with no report behind it, so every change rated high stayed
// held with nothing saying why. A cleanup fire ends with its report posted or failed, naming the gap.
describe('a cleanup fire whose session completes (BC-9, ISS-814)', () => {
  async function liveFire(): Promise<{ fireId: string; sessionId: string }> {
    await debts({ items: [red('low')] });
    const [schedule] = await rows<{ id: string }>(
      sql`SELECT id FROM schedules WHERE project_id = ${projectId} AND kind = 'cleanup'`,
    );
    const [run] = await rows<{ id: string }>(sql`
      INSERT INTO pipeline_runs (project_id, kind, status, started_at, metadata)
      VALUES (${projectId}, 'system', 'running', now(), '{}'::jsonb) RETURNING id`);
    const [session] = await rows<{ id: string }>(sql`
      INSERT INTO agent_sessions (project_id, pipeline_run_id, kind, status)
      VALUES (${projectId}, ${run?.id}, 'chat', 'running') RETURNING id`);
    const [fire] = await rows<{ id: string }>(sql`
      INSERT INTO schedule_runs (schedule_id, project_id, trigger, status, session_id, started_at)
      VALUES (${schedule?.id}, ${projectId}, 'manual', 'running', ${session?.id}, now()) RETURNING id`);
    if (!fire || !session) throw new Error('no cleanup fire was opened');
    return { fireId: fire.id, sessionId: session.id };
  }
  const complete = (sessionId: string) =>
    transitionSessions(db, {
      to: 'completed',
      set: { updatedAt: new Date() },
      where: eq(agentSessions.id, sessionId),
      reason: 'its turn ended',
      actor: { type: 'system' },
      source: 'fast-delivery-e2e',
    });
  /**
   * A report naming every open debt as remaining, which is the whole shape a report owes: red, or
   * green once each of them is carried, as a report's result follows from what it leaves (BC-10).
   */
  const reportFor = async (body: Doc) => {
    const open = (await ledger()).body.open as Doc[];
    if (body.result === 'green') {
      for (const d of open) {
        const carried = await call('POST', `/api/projects/${projectId}/debts/${d.id}/carry`, {
          trades: 'the check stays red',
          costs: 'nothing in this test',
          endsWhen: 'the test ends',
        });
        expect(carried.status, JSON.stringify(carried.body)).toBe(200);
      }
    }
    return reportCleanup({
      result: 'red',
      remains: open.map((d) => ({ debt: d.id, why: 'left for later' })),
      ...body,
    });
  };
  const fireRow = async (fireId: string) =>
    (
      await rows<{ status: string; error: string | null }>(
        sql`SELECT status, error FROM schedule_runs WHERE id = ${fireId}`,
      )
    )[0];

  it('is failed, naming the report it did not post, when the run ends its turn without one', async () => {
    const { fireId, sessionId } = await liveFire();
    await complete(sessionId);
    const fire = await fireRow(fireId);
    expect(fire?.status, 'a cleanup fire with no report settled as a success').toBe('failed');
    expect(fire?.error).toContain('ended without a report');
    expect(fire?.error).toContain(fireId);
  });

  it('succeeds once a report names the fire, red as well as green', async () => {
    for (const result of ['green', 'red'] as const) {
      const { fireId, sessionId } = await liveFire();
      const posted = await reportFor({ fire: fireId, result });
      expect([posted.status, codes(posted)]).toEqual([201, []]);
      await complete(sessionId);
      expect(await fireRow(fireId)).toMatchObject({ status: 'success', error: null });
    }
  });

  it('is not answered by a report that names no fire, or another one', async () => {
    const other = await liveFire();
    const { fireId, sessionId } = await liveFire();
    expect((await reportFor({})).status).toBe(201);
    expect((await reportFor({ fire: other.fireId })).status).toBe(201);
    await complete(sessionId);
    expect((await fireRow(fireId))?.status).toBe('failed');
  });
});
