/**
 * A job's session never waits in its process between turns: a box at the claim floor reports
 * `working` or `starting` for a pool job. A batch reporting `awaiting_input` for one is refused
 * `JOB_SESSION_PARK_RETIRED`, rather than storing a park that every clock exempts. Through the
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

let say: (who: 'box', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let box = '';

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { issueDeviceCredential } = await import('../../src/devices/credential.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  box = await createTestDevice(ownerId);
  await bindTestRunner(projectId, box);
  say = requester(app, {
    box: await issueDeviceCredential({ deviceId: box, holderUserId: ownerId }),
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** A pool job out on `box` with its pipeline session running. */
async function jobWithSession(): Promise<{ jobId: string; sessionId: string }> {
  const runId = randomUUID();
  const jobId = randomUUID();
  const sessionId = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'interactive', 'running')
  `);
  await db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, user_id, pipeline_run_id, kind, status, device_id,
                                runtime_state, started_at)
    VALUES (${sessionId}, ${projectId}, ${ownerId}, ${runId}, 'pipeline', 'running', ${box},
            'working', now())
  `);
  await db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status, device_id, payload,
                      dispatched_at, agent_session_id)
    VALUES (${jobId}, ${projectId}, ${runId}, ${ownerId}, 'smoke', 'dispatched', ${box},
            '{}'::jsonb, now(), ${sessionId})
  `);
  return { jobId, sessionId };
}

async function runtimeOf(sessionId: string): Promise<string | null> {
  const [row] = await rows<{ runtime_state: string | null }>(
    sql`SELECT runtime_state FROM agent_sessions WHERE id = ${sessionId}`,
  );
  return row?.runtime_state ?? null;
}

const report = (jobId: string, runtimeState: string) =>
  say('box', 'POST', `/api/jobs/${jobId}/events`, {
    events: [{ kind: 'progress', data: { source: 'pool_jobs', runtimeState } }],
  });

describe("a job's session reporting a park", () => {
  it('is refused JOB_SESSION_PARK_RETIRED, and the session does not read as parked', async () => {
    const { jobId, sessionId } = await jobWithSession();
    const refused = await report(jobId, 'awaiting_input');
    expect(refused.status, JSON.stringify(refused.json)).toBe(422);
    expect(refusalCodes(refused)).toEqual(['JOB_SESSION_PARK_RETIRED']);
    expect(await runtimeOf(sessionId)).toBe('working');
  });

  it('takes the states a box at the claim floor reports', async () => {
    const { jobId, sessionId } = await jobWithSession();
    ok(await report(jobId, 'starting'));
    expect(await runtimeOf(sessionId)).toBe('starting');
  });
});
