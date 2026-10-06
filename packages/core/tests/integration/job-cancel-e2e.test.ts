/**
 * ISS-252 — a person's cancel of a dispatched job settles only when the box it runs on says it is
 * done with it (`cancel-job.ts:settleConfirmedCancel`): a kill-ack `killed`, sent once the process
 * is closed, or a failure report, sent as the box closes it. Until then the job stays `dispatched` and its heartbeat is refused
 * `JOB_CANCEL_REQUESTED`, the channel a lost `job.cancel` frame cannot take with it. Through the
 * app, against Postgres.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  ok,
  type Reply,
  refusalCodes,
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

type Who = 'owner' | 'box' | 'other';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let box = '';

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { issueDeviceCredential } = await import('../../src/devices/credential.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  box = await createTestDevice(ownerId);
  const other = await createTestDevice(ownerId);
  await bindTestRunner(projectId, box);
  say = requester(app, {
    owner: await signUserToken(ownerId),
    box: await issueDeviceCredential({ deviceId: box, holderUserId: ownerId }),
    other: await issueDeviceCredential({ deviceId: other, holderUserId: ownerId }),
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** A pool job out on `box`, as a box that took it from the pool leaves it. */
async function dispatchedJob(): Promise<string> {
  const runId = randomUUID();
  const jobId = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'interactive', 'running')
  `);
  await db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status, device_id, payload,
                      dispatched_at)
    VALUES (${jobId}, ${projectId}, ${runId}, ${ownerId}, 'smoke', 'dispatched', ${box},
            '{}'::jsonb, now())
  `);
  return jobId;
}

async function statusOf(jobId: string): Promise<string> {
  const [row] = await rows<{ status: string }>(sql`SELECT status FROM jobs WHERE id = ${jobId}`);
  return row?.status ?? 'gone';
}

/** The `job.changed` frames announcing this job `cancelled`. */
async function cancelledFrames(jobId: string): Promise<number> {
  const [row] = await rows<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM pipeline_outbox
    WHERE type = 'job.changed' AND payload->>'jobId' = ${jobId}
      AND payload->>'event' = 'job.cancelled'
  `);
  return row?.n ?? 0;
}

const beat = (jobId: string) =>
  say('box', 'POST', `/api/jobs/${jobId}/events`, {
    events: [{ kind: 'progress', data: { source: 'pool_jobs' } }],
  });

const cancel = async (jobId: string) => {
  const body = ok(await say('owner', 'POST', `/api/jobs/${jobId}/cancel`, {}));
  expect(body).toMatchObject({ status: 'dispatched', cancellationRequested: true });
};

describe('a dispatched job a person cancelled', () => {
  it('takes heartbeats until a cancel is requested', async () => {
    const jobId = await dispatchedJob();
    ok(await beat(jobId));
  });

  it('stays dispatched, and its heartbeat is refused JOB_CANCEL_REQUESTED', async () => {
    const jobId = await dispatchedJob();
    await cancel(jobId);
    expect(await statusOf(jobId)).toBe('dispatched');
    const refused = await beat(jobId);
    expect(refused.status, JSON.stringify(refused.json)).toBe(422);
    expect(refusalCodes(refused)).toEqual(['JOB_CANCEL_REQUESTED']);
  });

  it('settles cancelled on kill-ack killed, announced job.cancelled, and is terminal after', async () => {
    const jobId = await dispatchedJob();
    await cancel(jobId);
    const acked = ok(
      await say('box', 'POST', `/api/jobs/${jobId}/kill-ack`, { outcome: 'killed' }),
    );
    expect(acked).toMatchObject({ settled: true });
    expect(await statusOf(jobId)).toBe('cancelled');
    expect(await cancelledFrames(jobId)).toBe(1);
    expect(refusalCodes(await beat(jobId))).toEqual(['JOB_TERMINATED']);
  });

  it('is not settled by kill-ack not_found, which an older box answers for a pane it cannot see', async () => {
    const jobId = await dispatchedJob();
    await cancel(jobId);
    const acked = ok(
      await say('box', 'POST', `/api/jobs/${jobId}/kill-ack`, { outcome: 'not_found' }),
    );
    expect(acked).toMatchObject({ settled: false });
    expect(await statusOf(jobId)).toBe('dispatched');
    expect(await cancelledFrames(jobId)).toBe(0);
  });

  it('is not settled by a kill-ack from a box it is not out on', async () => {
    const jobId = await dispatchedJob();
    await cancel(jobId);
    const refused = await say('other', 'POST', `/api/jobs/${jobId}/kill-ack`, {
      outcome: 'killed',
    });
    expect(refused.status, JSON.stringify(refused.json)).toBe(403);
    expect(await statusOf(jobId)).toBe('dispatched');
  });

  it('ends cancelled, not failed, when its box reports it has ended the job', async () => {
    const jobId = await dispatchedJob();
    await cancel(jobId);
    const reason = 'the job pane went quiet and was concluded';
    const failed = ok(await say('box', 'POST', `/api/jobs/${jobId}/fail`, { error: reason }));
    expect(failed).toMatchObject({
      status: 'cancelled',
      error: reason,
      retry: { scheduled: false, reason: 'cancellation_requested' },
    });
    expect(await statusOf(jobId)).toBe('cancelled');
    expect(await cancelledFrames(jobId)).toBe(1);
  });
});

describe('a dispatched job nobody cancelled', () => {
  it('is not moved by a kill-ack, which the kill-before-reap gate only stamps', async () => {
    const jobId = await dispatchedJob();
    const acked = ok(
      await say('box', 'POST', `/api/jobs/${jobId}/kill-ack`, { outcome: 'killed' }),
    );
    expect(acked).toMatchObject({ settled: false });
    expect(await statusOf(jobId)).toBe('dispatched');
  });

  it('still ends failed when its box reports it has ended the job', async () => {
    const jobId = await dispatchedJob();
    const failed = ok(await say('box', 'POST', `/api/jobs/${jobId}/fail`, { error: 'boom' }));
    expect(failed).toMatchObject({ status: 'failed' });
    expect(await cancelledFrames(jobId)).toBe(0);
  });
});
