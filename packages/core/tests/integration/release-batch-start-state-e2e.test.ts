/**
 * ISS-1323 — a release batch no box has taken reads, through its own state, differently from one
 * that is working. Measured on mowment: a batch pressed while the box could admit nothing read
 * `runStatus: running`, `attempts: []`, `method: null`, the same as a batch whose agent had not
 * written yet. Real Postgres and the real route, each job-row shape planted on the row itself.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let ownerId: string;
let jwt: string;

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  server = await startTestServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  jwt = await signUserToken(owner.id);
  await fx.declareProduction();
  await fx.seedReleaseRunner();
});

type Start = Record<string, unknown> & { kind: string; why?: string; reason?: string };

async function startOf(runId: string): Promise<{ start: Start; crossed: string[] }> {
  const res = await fetch(
    `${server.baseUrl}/api/projects/${projectId}/release-batches/${runId}/state`,
    {
      headers: { authorization: `Bearer ${jwt}` },
    },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { start: Start; bounds: { crossedNames: string[] } };
  return { start: body.start, crossed: body.bounds.crossedNames };
}

async function opened(): Promise<{ runId: string; jobId: string }> {
  const issue = await fx.insertIssue();
  const { runId, jobId } = await fx.claim([issue], { deploy: false });
  return { runId, jobId };
}

async function deviceOf(): Promise<{ id: string; name: string }> {
  const rows = await harness.db.execute(sql`
    SELECT d.id, d.name FROM runners r JOIN devices d ON d.id = r.device_id
    WHERE r.project_id = ${projectId} LIMIT 1
  `);
  return { id: String(rows[0]?.id), name: String(rows[0]?.name) };
}

describe('the state of a release batch says whether a box has started it', () => {
  it('reads `waiting` and names the eligible box that has not claimed it', async () => {
    const { runId } = await opened();
    const device = await deviceOf();

    const { start } = await startOf(runId);

    expect(start.kind).toBe('waiting');
    expect(start.reason).toBe('eligible-not-taken');
    expect(start.why).toContain(`\`${device.name}\``);
    expect(typeof start.since).toBe('string');
    const { RELEASE_UNSTARTED_DEADLINE_MS } = await import('../../src/release-batch/job-start.js');
    expect(Date.parse(String(start.handedBackAt)) - Date.parse(String(start.since))).toBe(
      RELEASE_UNSTARTED_DEADLINE_MS,
    );
  });

  it('reads `waiting` and names what holds each box when none can take it', async () => {
    const { runId } = await opened();
    const device = await deviceOf();
    await harness.db.execute(
      sql`UPDATE runners SET status = 'draining' WHERE project_id = ${projectId}`,
    );

    const { start } = await startOf(runId);

    expect(start.kind).toBe('waiting');
    expect(start.reason).toBe('no-eligible-box');
    expect(start.why).toContain(`\`${device.name}\` is \`draining\``);
  });

  it('reads `claimed` when a session holds the job and has not started it', async () => {
    const { runId, jobId } = await opened();
    await harness.db.execute(sql`UPDATE jobs SET held_by = ${randomUUID()} WHERE id = ${jobId}`);

    expect((await startOf(runId)).start.kind).toBe('claimed');
  });

  it('reads `taken`, with when and on which box, once the job is dispatched', async () => {
    const { runId, jobId } = await opened();
    const device = await deviceOf();
    await harness.db.execute(sql`
      UPDATE jobs SET status = 'dispatched', dispatched_at = now(), device_id = ${device.id}
      WHERE id = ${jobId}
    `);

    const { start } = await startOf(runId);

    expect(start).toMatchObject({ kind: 'taken', device: device.name });
    expect(typeof start.at).toBe('string');
  });

  it('reads `handed-back` with the deadline’s own reason, and no stalled bound', async () => {
    const { runId, jobId } = await opened();
    await harness.db.execute(sql`
      UPDATE jobs SET queued_at = now() - interval '2 hours' WHERE id = ${jobId}
    `);
    const { recoverUnstartedReleaseBatches } = await import(
      '../../src/release-batch/unstarted-recovery.js'
    );
    const { UNSTARTED_HANDBACK_REASON } = await import('../../src/release-batch/job-start.js');
    expect((await recoverUnstartedReleaseBatches()).recovered).toBe(1);

    const { start, crossed } = await startOf(runId);

    expect(start.kind).toBe('handed-back');
    expect(start.why).toContain(UNSTARTED_HANDBACK_REASON);
    expect(crossed).not.toContain('stall');
  });

  it('reads `ended` with the job’s own error when it failed before any box took it', async () => {
    const { runId, jobId } = await opened();
    await harness.db.execute(sql`
      UPDATE jobs SET status = 'failed', error = 'the pane could not start', finished_at = now()
      WHERE id = ${jobId}
    `);

    const { start } = await startOf(runId);

    expect(start).toMatchObject({ kind: 'ended', status: 'failed' });
    expect(start.why).toContain('the pane could not start');
  });

  it('reads `none` for a release run that holds no release job', async () => {
    const { runId, jobId } = await opened();
    await harness.db.execute(sql`DELETE FROM jobs WHERE id = ${jobId}`);

    expect((await startOf(runId)).start.kind).toBe('none');
  });
});
