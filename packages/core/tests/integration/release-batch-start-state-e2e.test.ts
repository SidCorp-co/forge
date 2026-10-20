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
let ownerEmail: string;
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
  ownerEmail = owner.email;
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
    // r2: the person who pressed reads it, so no runner term and no timestamp the screen prints.
    expect(start.why).not.toMatch(/pool job|slot|claimed/);
    expect(start.why).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
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
    expect(String(start.why).match(/never started/g) ?? []).toHaveLength(1);
    expect(crossed).not.toContain('stall');
  });

  it('reads `aborted`, naming who aborted it, when and why, for a batch aborted before any box took it (r2)', async () => {
    const { runId } = await opened();
    const reason = 'wrong roster, pressing again with ISS-9';

    const res = await fetch(
      `${server.baseUrl}/api/projects/${projectId}/release-batches/${runId}/abort`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      },
    );
    expect(res.status).toBe(200);

    const { start } = await startOf(runId);

    expect(start.kind).toBe('aborted');
    // ISS-1229 r21: who aborted it is named as core calls them, never by address.
    expect(start.by).toBe('Another member');
    expect(start.by).not.toBe(ownerEmail);
    expect(start.why).toBe(reason);
    expect(typeof start.at).toBe('string');
  });

  it('names the issues the run was opened with, not those now at the gate (r2)', async () => {
    const mine = await fx.insertIssue();
    const { runId } = await fx.claim([mine], { deploy: false });
    const later = await fx.insertIssue();

    const res = await fetch(
      `${server.baseUrl}/api/projects/${projectId}/release-batches/${runId}/state`,
      { headers: { authorization: `Bearer ${jwt}` } },
    );
    const body = (await res.json()) as { runIssues?: Array<{ id: string; status: string }> };

    expect(body.runIssues?.map((i) => i.id)).toEqual([mine]);
    expect(body.runIssues?.[0]?.status).toBe('releasing');
    expect(body.runIssues?.map((i) => i.id)).not.toContain(later);
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

  // ISS-1421 r6, criterion 93 — anhome's release page said "This release never started … before any
  // box took it" beside the method a box announced: its first job was taken, and the newest, a
  // successor held on a decision, was cancelled by the hand-back. Any taken job means started.
  it('reads `taken` off the job a box took, though a later successor was cancelled untaken', async () => {
    const { runId, jobId } = await opened();
    const device = await deviceOf();
    await harness.db.execute(sql`
      UPDATE jobs SET status = 'failed', dispatched_at = now() - interval '5 minutes',
        device_id = ${device.id}, finished_at = now() - interval '4 minutes',
        queued_at = now() - interval '6 minutes'
      WHERE id = ${jobId}
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs
      SELECT (jsonb_populate_record(j, jsonb_build_object(
        'id', gen_random_uuid(), 'status', 'cancelled', 'retry_of', j.id,
        'dispatched_at', NULL, 'device_id', NULL, 'queued_at', now(), 'finished_at', now(),
        'error', 'handed back on a decision a person owes'))).*
      FROM jobs j WHERE j.id = ${jobId}
    `);

    const { start } = await startOf(runId);

    expect(start).toMatchObject({ kind: 'taken', device: device.name });
    expect(JSON.stringify(start)).not.toMatch(/never started|before any box took it/);
  });

  // A taken job starts the stall clock, and an ended run must stop it: anhome's cancelled run read
  // "Holding: this run is past its stall bound … until a person looks" an hour after it ended.
  it('reads an ended run as holding nothing, its stall measured up to its end', async () => {
    const { runId, jobId } = await opened();
    const device = await deviceOf();
    await harness.db.execute(sql`
      UPDATE jobs SET status = 'failed', dispatched_at = now() - interval '40 minutes',
        device_id = ${device.id}, finished_at = now() - interval '39 minutes'
      WHERE id = ${jobId}
    `);
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET status = 'cancelled', finished_at = now() - interval '39 minutes'
      WHERE id = ${runId}
    `);

    const res = await fetch(
      `${server.baseUrl}/api/projects/${projectId}/release-batches/${runId}/state`,
      { headers: { authorization: `Bearer ${jwt}` } },
    );
    const body = (await res.json()) as {
      bounds: {
        holding: boolean;
        bounds: { name: string; crossed: boolean; measuredMs: number }[];
      };
    };

    expect(body.bounds.holding).toBe(false);
    const stall = body.bounds.bounds.find((b) => b.name === 'stall');
    expect(stall?.crossed).toBe(false);
    expect(stall?.measuredMs).toBeLessThan(5 * 60_000);
  });

  it('reads `none` for a release run that holds no release job', async () => {
    const { runId, jobId } = await opened();
    await harness.db.execute(sql`DELETE FROM jobs WHERE id = ${jobId}`);

    expect((await startOf(runId)).start.kind).toBe('none');
  });
});
