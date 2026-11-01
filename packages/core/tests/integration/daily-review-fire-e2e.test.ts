/**
 * ISS-862 (owner, 2026-11-01): every project gets a daily review. A `daily_review` schedule's fire
 * hands the project's live master its review brief through the session inbox, as a nudge typed into
 * its pane: a goal and where its facts are read, never a report core wrote. A fire with no master to
 * tell is settled skipped with the refusal naming why, never in silence. Against real Postgres.
 *
 * @direct-test-of packages/core/src/schedules/daily-review-dispatch.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

type Who = 'owner' | 'box';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const deviceId = await createTestDevice(ownerId);
  await bindTestRunner(projectId, deviceId);
  const box = await mintPat({
    permissions: ['*'],
    userId: ownerId,
    name: 'box',
    deviceId,
    projectIds: [projectId],
  });
  say = requester(app, { owner: await signUserToken(ownerId), box: box.plaintext }) as typeof say;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function dailyReview(): Promise<string> {
  const created = ok(
    await say('owner', 'POST', '/api/schedules', {
      projectId,
      name: 'Daily review',
      cron: '0 18 * * *',
      timeZone: 'Asia/Ho_Chi_Minh',
      kind: 'daily_review',
    }),
    201,
  );
  return created.id as string;
}

/** Press run, and read back the fire it settled: a missed one answers 422 naming why, a delivered one 202. */
async function fire(scheduleId: string, status: number) {
  const run = await say('owner', 'POST', `/api/schedules/${scheduleId}/run`);
  expect(run.status, JSON.stringify(run.body)).toBe(status);
  const [settled] = await rows<{ id: string; status: string; reason: string | null; refusal: string | null; output: string | null }>(
    sql`SELECT id, status, reason, refusal, output FROM schedule_runs WHERE schedule_id = ${scheduleId} ORDER BY started_at DESC LIMIT 1`,
  );
  if (!settled) throw new Error('the run pressed recorded no fire');
  return settled;
}

describe('a daily review fire (ISS-862)', () => {
  it('takes no prompt: the master is briefed by core, never by a schedule prompt', async () => {
    const refused = await say('owner', 'POST', '/api/schedules', {
      projectId,
      name: 'Daily review',
      cron: '0 18 * * *',
      kind: 'daily_review',
      prompt: 'write the report like this',
    });
    expect(refused.status).toBe(400);
  });

  it('is recorded missed by name when the project has no live master', async () => {
    const settled = await fire(await dailyReview(), 422);
    expect(settled).toMatchObject({ status: 'skipped', reason: 'gate-refused', refusal: 'DAILY_REVIEW_NO_MASTER' });
    expect(settled.output).toContain('no live master');
  });

  it('hands the live master its brief, once per fire, as a nudge in its pane', async () => {
    const sessionId = ok(
      await say('box', 'POST', '/api/devices/me/master-session', {
        projectId,
        name: 'forge-master',
        maxJobPanes: 1,
      }),
    ).sessionId as string;
    const settled = await fire(await dailyReview(), 202);
    expect(settled.status, JSON.stringify(settled)).toBe('success');
    const fireId = settled.id;
    const inbox = await rows<{ kind: string; body: string }>(
      sql`SELECT kind, body FROM session_inbox WHERE agent_session_id = ${sessionId} AND intent_id = ${`daily-review:${fireId}`}`,
    );
    expect(inbox).toHaveLength(1);
    const [brief] = inbox as [Doc];
    expect(brief.kind).toBe('inject');
    expect(brief.body).toContain('Vietnamese');
    expect(brief.body).toContain('Forge-Communicate');
    expect(brief.body).toContain(`/api/projects/${projectId}/runs/standing?scope=finished`);
  });
});
