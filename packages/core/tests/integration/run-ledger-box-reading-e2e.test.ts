/**
 * ISS-1228 round 11 — the runs tab reads its box and its leases from core as well as from the box.
 * Judge-27 saw a run on a box offline 52 minutes read "the box says this is live", and "leases 2/2"
 * with a check on a run whose box called its leases returned while core still held them and refused
 * a second run with ISSUE_LEASE_HELD.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let deviceId: string;
let jwt: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  server = await startTestServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  projectId = (await createTestProject(harness.db, owner.id)).id;
  deviceId = (await createTestDevice(harness.db, owner.id)).id;
  await bindTestRunner(harness.db, { projectId, deviceId });
  const { signUserToken } = await import('../../src/auth/jwt.js');
  jwt = await signUserToken(owner.id);
});

type Row = {
  runId: string;
  deviceStatus: string | null;
  deviceLastSeenAt: string | null;
  issues: Array<{ issueKey: string; leaseReturned: boolean; coreHolds: boolean }>;
};

async function rows(): Promise<Row[]> {
  const res = await fetch(`${server.baseUrl}/api/projects/${projectId}/run-sessions`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Row[] }).items;
}

async function run(issues: unknown[]): Promise<string> {
  const runId = randomUUID();
  const sessionId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${projectId}::uuid, 'system', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title, started_at, last_heartbeat_at)
    VALUES (${sessionId}, ${projectId}::uuid, ${deviceId}::uuid, ${runId}, 'run_session', 'running', 'run: one', now(), now())
  `);
  await harness.db.execute(sql`
    INSERT INTO device_run_ledger (device_id, run_id, project_id, session_id, worktree_path, boot_id,
                                   incarnation, work, issues, observed_at)
    VALUES (${deviceId}::uuid, ${runId}, ${projectId}::uuid, ${sessionId}, '/tmp/wt', 'boot-1', 'live',
            'runnable', ${JSON.stringify(issues)}::jsonb, now())
  `);
  await harness.db.execute(sql`
    INSERT INTO issue_leases (project_id, issue_key, session_id, device_id, run_id)
    VALUES (${projectId}::uuid, 'ISS-4', ${sessionId}, ${deviceId}::uuid, ${runId})
  `);
  return runId;
}

describe("the runs tab reads core's word on the box and the leases (ISS-1228 round 11)", () => {
  it("carries the box's status and when core last heard it", async () => {
    await harness.db.execute(sql`
      UPDATE devices SET status = 'offline', last_seen_at = now() - interval '52 minutes' WHERE id = ${deviceId}::uuid
    `);
    const runId = await run([]);

    const row = (await rows()).find((r) => r.runId === runId);

    expect(row?.deviceStatus).toBe('offline');
    expect(Date.now() - Date.parse(row?.deviceLastSeenAt ?? '')).toBeGreaterThan(51 * 60_000);
  });

  it('says core still holds a lease the box calls returned, and holds none it has given back', async () => {
    const runId = await run([
      { issueKey: 'ISS-4', leaseReturned: true },
      { issueKey: 'ISS-5', leaseReturned: true },
    ]);

    const row = (await rows()).find((r) => r.runId === runId);

    expect(row?.issues).toEqual([
      { issueKey: 'ISS-4', leaseReturned: true, coreHolds: true },
      { issueKey: 'ISS-5', leaseReturned: true, coreHolds: false },
    ]);
  });
});
