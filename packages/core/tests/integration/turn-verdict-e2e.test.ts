/**
 * Whether a turn ending is also the job ending — real Postgres.
 *
 * ISS-873 phase 3. The runner asks this once per duplex turn and does exactly
 * one of two things with the answer: finish the job, or stay resident holding a
 * one of the box's few duplex session slots. So the two directions are not
 * symmetric — a wrong `false` wedges a slot until the residency backstop, while
 * a wrong `true` finishes a job that is retryable.
 *
 * The status vocabulary is the whole predicate and it is shared with
 * `answer-resume.ts`: `needs_info` is the question park, `waiting` and `on_hold`
 * are pauses a HUMAN chose and no session is sitting on them.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let deviceId: string;
let deviceToken: string;
let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;
let seq = 0;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';

  const { jobTurnVerdictRoutes } = await import('../../src/jobs/turn-verdict-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{
    Variables: import('../../src/middleware/request-id.js').RequestIdVars;
  }>();
  app.use('*', requestId());
  app.route('/api/jobs', jobTurnVerdictRoutes as never);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;

  const { pairDevice } = await import('../helpers/pair-device.js');
  const issued = await pairDevice({ ownerId, name: 'd1', platform: 'linux' });
  deviceId = issued.device.id;
  deviceToken = issued.plaintext;
});

async function jobOn(issueStatus: string | null): Promise<string> {
  const jobId = randomUUID();
  const runId = randomUUID();
  let issueId: string | null = null;
  if (issueStatus !== null) {
    issueId = randomUUID();
    seq += 1;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${issueId}, ${projectId}, ${seq}, ${`i${seq}`}, ${issueStatus}, ${ownerId})
    `);
  }
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'interactive', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, issue_id, device_id, created_by,
                      type, status)
    VALUES (${jobId}, ${projectId}, ${runId}, ${issueId}, ${deviceId}, ${ownerId},
            'code', 'running')
  `);
  return jobId;
}

async function ask(jobId: string, token = deviceToken): Promise<Response> {
  return app.request(`/api/jobs/${jobId}/turn-verdict`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function done(jobId: string): Promise<boolean> {
  const r = await ask(jobId);
  expect(r.status).toBe(200);
  return ((await r.json()) as { done: boolean }).done;
}

describe('the turn verdict', () => {
  // cm:guard the ONLY status that keeps a session resident. Widening it is how a runner slot is held for a pause a human chose, and `answer-resume.ts` carries the same rule from the other end — the two must name one status or a park is resumable by one and invisible to the other.
  it('keeps the session resident while the issue is parked on a question', async () => {
    expect(await done(await jobOn('needs_info'))).toBe(false);
  });

  it('finishes the job when the driver never parked', async () => {
    expect(await done(await jobOn('in_progress'))).toBe(true);
  });

  it('finishes the job on a pause a human chose rather than sitting on it', async () => {
    expect(await done(await jobOn('waiting'))).toBe(true);
    expect(await done(await jobOn('on_hold'))).toBe(true);
  });

  // cm:guard an answer this endpoint cannot give must still be an answer. A job with no issue can never be parked on a question, so reading it as "unknown" and staying resident holds the slot forever on a job nobody can ever reply to.
  it('finishes a job that has no issue at all', async () => {
    expect(await done(await jobOn(null))).toBe(true);
  });

  it('refuses a job dispatched to another device', async () => {
    const { pairDevice } = await import('../helpers/pair-device.js');
    const other = await pairDevice({ ownerId, name: 'd2', platform: 'linux' });
    expect((await ask(await jobOn('needs_info'), other.plaintext)).status).toBe(403);
  });

  it('404s an unknown job rather than answering for it', async () => {
    expect((await ask(randomUUID())).status).toBe(404);
  });
});
