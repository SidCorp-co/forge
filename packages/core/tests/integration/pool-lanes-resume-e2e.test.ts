/**
 * Resumption through the job pool, and the pool's own door, against a real
 * Postgres. A held job released and a retry minted are each walked through the
 * pool with the prompt of the job they resume. A prompt-less row that reached
 * the pool is refused at prepare and settled where it stands, so it no longer
 * heads its project's pool.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import {
  countRows,
  jobFacts,
  type PoolBox,
  plantJob as plant,
  seedPoolBox,
  walkThroughPool,
} from '../helpers/pool-lanes-fixture.js';

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let m: {
  readPool: typeof import('../../src/devices/pool.js').readPool;
  prepare: typeof import('../../src/devices/claim.js').prepareJobForMaster;
  start: typeof import('../../src/devices/claim.js').startJobForMaster;
  holdJobForReason: typeof import('../../src/jobs/hold.js').holdJobForReason;
  releaseHeldJobs: typeof import('../../src/jobs/hold.js').releaseHeldJobs;
  scheduleAutoRetryWithVerify: typeof import('../../src/jobs/retry.js').scheduleAutoRetryWithVerify;
  reapConcludedRuns: typeof import('../../src/pipeline/runs-concluded.js').reapConcludedRuns;
  settleNoPromptJob: typeof import('../../src/jobs/pool-served.js').settleNoPromptJob;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  const pool = await import('../../src/devices/pool.js');
  const claim = await import('../../src/devices/claim.js');
  const hold = await import('../../src/jobs/hold.js');
  const retry = await import('../../src/jobs/retry.js');
  const concluded = await import('../../src/pipeline/runs-concluded.js');
  const served = await import('../../src/jobs/pool-served.js');
  m = {
    readPool: pool.readPool,
    prepare: claim.prepareJobForMaster,
    start: claim.startJobForMaster,
    holdJobForReason: hold.holdJobForReason,
    releaseHeldJobs: hold.releaseHeldJobs,
    scheduleAutoRetryWithVerify: retry.scheduleAutoRetryWithVerify,
    reapConcludedRuns: concluded.reapConcludedRuns,
    settleNoPromptJob: served.settleNoPromptJob,
  };
  const { jobLifecycleDeviceRoutes } = await import('../../src/jobs/lifecycle-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/jobs', jobLifecycleDeviceRoutes as never);
  app.onError(errorHandler);
}, 120_000);

let box: PoolBox;
let projectId: string;
let deviceId: string;
const count = (table: 'jobs' | 'pipeline_runs') => countRows(harness, projectId, table);
const jobRow = (jobId: string) => jobFacts(harness, jobId);
const plantJob = (opts: { payload: Record<string, unknown>; queuedAgo?: string }) =>
  plant(harness, box, opts);

beforeEach(async () => {
  await truncateAll(harness.db);
  box = await seedPoolBox(harness);
  ({ projectId, deviceId } = box);
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

const walk = (jobId: string, prompt: string, opts?: { resumed?: boolean }) =>
  walkThroughPool(
    harness,
    box,
    {
      readPool: m.readPool,
      prepare: m.prepare,
      start: m.start,
      request: (p, i) => app.request(p, i),
    },
    jobId,
    prompt,
    opts,
  );

describe('lanes that resume a job are claimed and finished through the pool', () => {
  async function failedJob(prompt: string) {
    const { jobId } = await plantJob({ payload: { promptString: prompt } });
    await harness.db.execute(sql`
      UPDATE jobs SET status = 'failed', finished_at = now(), error = 'infra: connection reset',
                      failure_action = 'retry'
      WHERE id = ${jobId}
    `);
    const { db } = await import('../../src/db/client.js');
    const { jobs } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!row) throw new Error('planted job vanished');
    return row;
  }

  it('hold release', async () => {
    const original = await failedJob('resume the held work');
    const heldId = await m.holdJobForReason(original, 'verify_unavailable');
    expect(heldId).not.toBeNull();
    if (!heldId) return;
    await harness.db.execute(sql`
      UPDATE jobs SET retry_after_at = now() - interval '1 minute' WHERE id = ${heldId}
    `);
    expect(await m.releaseHeldJobs(projectId)).toBe(1);
    await walk(heldId, 'resume the held work', { resumed: true });
  });

  it('retry', async () => {
    const original = await failedJob('try the work again');
    const outcome = await m.scheduleAutoRetryWithVerify(original, 'infra: connection reset');
    expect(outcome.scheduled, JSON.stringify(outcome)).toBe(true);
    const rows = (await harness.db.execute(sql`
      SELECT id FROM jobs WHERE retry_of = ${original.id}
    `)) as unknown as Array<{ id: string }>;
    const retryId = rows[0]?.id;
    if (!retryId) throw new Error('no retry minted');

    const early = await m.readPool({ deviceId, projectId, limit: 50 });
    expect(
      early.map((e) => e.jobId),
      'a retry inside its cooldown is not offered',
    ).not.toContain(retryId);
    await harness.db.execute(sql`
      UPDATE jobs SET retry_after_at = now() - interval '1 second' WHERE id = ${retryId}
    `);
    await walk(retryId, 'try the work again', { resumed: true });
  });
});

describe('a prompt-less row that reached the pool is refused and settled at prepare', () => {
  it('answers no_prompt and leaves the job unheld', async () => {
    const { jobId } = await plantJob({ payload: { kind: 'enrich' } });
    const refused = await m.prepare({ jobId, deviceId, sessionId: randomUUID() });
    expect(refused).toEqual({ ok: false, reason: 'no_prompt' });
    expect((await jobRow(jobId)).held_by).toBeNull();
  });

  it('settles it failed, terminal and named, with no retry and no hold behind it', async () => {
    const { jobId } = await plantJob({ payload: { cause: 'tick' } });
    await m.prepare({ jobId, deviceId, sessionId: randomUUID() });
    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toBe('POOL_JOB_NO_PROMPT');
    expect(row.failure_kind).toBe('code');
    expect(row.failure_action).toBe('terminal');
    expect(row.error).toContain('`custom`');

    const successors = (await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM jobs WHERE retry_of = ${jobId}
    `)) as unknown as Array<{ n: number }>;
    expect(successors[0]?.n).toBe(0);
    expect(await count('jobs')).toBe(1);
  });

  it('lets the runs-concluded sweep close the run it was the only job of', async () => {
    const { jobId, runId } = await plantJob({ payload: {} });
    await m.prepare({ jobId, deviceId, sessionId: randomUUID() });
    const pastTheQuietWindow = new Date(Date.now() + 24 * 60 * 60_000);
    await m.reapConcludedRuns(pastTheQuietWindow, { projectId });
    const rows = (await harness.db.execute(
      sql`SELECT status FROM pipeline_runs WHERE id = ${runId}`,
    )) as unknown as Array<{ status: string }>;
    expect(rows[0]?.status).toBe('failed');
  });

  it('no longer stops the pool reaching the prompted job queued behind it', async () => {
    const head = await plantJob({ payload: {}, queuedAgo: '10 minutes' });
    const behind = await plantJob({ payload: { promptString: 'the work behind' } });

    const first = await m.readPool({ deviceId, projectId, limit: 50 });
    expect(first[0]?.jobId).toBe(head.jobId);
    const refused = await m.prepare({ jobId: head.jobId, deviceId, sessionId: randomUUID() });
    expect(refused.ok).toBe(false);

    const next = await m.readPool({ deviceId, projectId, limit: 50 });
    expect(next[0]?.jobId, 'the prompted job now heads the pool').toBe(behind.jobId);
    await walk(behind.jobId, 'the work behind');
  });

  it('fails the reconcile run a refused reconcile job belonged to', async () => {
    const packetId = randomUUID();
    const skillId = randomUUID();
    const reconcileRunId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO update_packets (id, change, story, intent_class, applies_to)
      VALUES (${packetId}, 'tighten the rule', 'a person asked for it', 'procedure', 'forge-code')
    `);
    await harness.db.execute(sql`
      INSERT INTO skills (id, name, description, scope, project_id, prompt, source, content_hash)
      VALUES (${skillId}, 'forge-code', 'the code step', 'project', ${projectId}, 'body', 'user', 'h')
    `);
    await harness.db.execute(sql`
      INSERT INTO reconcile_runs (id, project_id, packet_id, skill_id, status)
      VALUES (${reconcileRunId}, ${projectId}, ${packetId}, ${skillId}, 'pending')
    `);
    const { jobId } = await plantJob({ payload: { reconcileRunId } });
    await harness.db.execute(sql`UPDATE jobs SET type = 'reconcile' WHERE id = ${jobId}`);

    expect(await m.prepare({ jobId, deviceId, sessionId: randomUUID() })).toEqual({
      ok: false,
      reason: 'no_prompt',
    });
    const rows = (await harness.db.execute(
      sql`SELECT status FROM reconcile_runs WHERE id = ${reconcileRunId}`,
    )) as unknown as Array<{ status: string }>;
    expect(rows[0]?.status, 'a failed reconcile job must not strand its run active').toBe('failed');
  });

  it('leaves a job that gained a prompt after it was read runnable', async () => {
    const { jobId } = await plantJob({ payload: {} });
    await harness.db.execute(sql`
      UPDATE jobs SET payload = '{"promptString":"arrived late"}'::jsonb WHERE id = ${jobId}
    `);
    expect(await m.settleNoPromptJob({ id: jobId, type: 'custom' })).toBe(false);
    expect((await jobRow(jobId)).status).toBe('queued');
    await walk(jobId, 'arrived late');
  });
});
