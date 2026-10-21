/**
 * ISS-1228 round 23 (judge-74, criterion 239) — the capacity notice was worded once, when it was
 * raised, and still said "both of its runners are online" after one went offline. Its words are taken
 * from the fleet each time the bell reads it.
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

type Vars = import('../../src/middleware/request-id.js').RequestIdVars;

let harness: TestDatabase;
let app: Hono<{ Variables: Vars }>;
let projectId: string;
let ownerId: string;
let token: string;
const boxes: string[] = [];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  const { notificationRoutes } = await import('../../src/notifications/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: Vars }>();
  app.use('*', requestId());
  app.route('/api/notifications', notificationRoutes);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  boxes.length = 0;
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  token = await signUserToken(ownerId);
  const { pairDevice } = await import('../helpers/pair-device.js');
  for (const name of ['box-d', 'box-e']) {
    const id = (await pairDevice({ ownerId, name, platform: 'linux' })).device.id;
    boxes.push(id);
    // Online on a build under the claim floor, so every claim is refused: the fleet's too_old.
    await harness.db.execute(sql`
      UPDATE devices SET agent_version = '0.10.0', status = 'online', last_seen_at = now() WHERE id = ${id}
    `);
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, name, type, status, last_seen_at)
      VALUES (${randomUUID()}, ${projectId}, ${id}, ${name}, 'claude-code', 'online', now())
    `);
  }
});

async function raiseNotice(): Promise<void> {
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 1, 'Scratch work', 'in_progress', ${ownerId})
  `);
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status) VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running')
  `);
  const jobId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status, payload, finished_at, error, failure_action)
    VALUES (${jobId}, ${projectId}, ${issueId}, ${runId}, ${ownerId}, 'drive', 'failed', '{"promptString":"go"}'::jsonb, now(),
            'infra: connection reset', 'retry')
  `);
  const { db } = await import('../../src/db/client.js');
  const { jobs } = await import('../../src/db/schema.js');
  const { eq } = await import('drizzle-orm');
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) throw new Error('planted job vanished');
  const { scheduleAutoRetryWithVerify } = await import('../../src/jobs/retry.js');
  await scheduleAutoRetryWithVerify(job, 'infra: connection reset');
}

async function goOffline(deviceId: string): Promise<void> {
  await harness.db.execute(sql`
    UPDATE devices SET status = 'offline', last_seen_at = now() - interval '1 hour' WHERE id = ${deviceId}
  `);
  await harness.db.execute(sql`
    UPDATE runners SET status = 'offline', last_seen_at = now() - interval '1 hour' WHERE device_id = ${deviceId}
  `);
}

type Row = { id: string; title: string; body: string | null; type: string };
async function bellRows(): Promise<Row[]> {
  const res = await app.request('/api/notifications', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Row[] }).items.filter((r) => r.type === 'pipeline_wedge');
}

async function membersOf(id: string): Promise<Row[]> {
  const res = await app.request(`/api/notifications/${id}/members`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Row[];
}

describe('the capacity notice counts the runners online when it is read (criterion 239)', () => {
  it('says both while both are online, and its one runner once the other went offline', async () => {
    await raiseNotice();
    const [raised] = await bellRows();
    expect(raised?.title).toMatch(
      /^ISS-1 — No capacity: every runner for this project is out of date$/,
    );
    expect(raised?.body).toContain('both of its runners are online but running a build older');

    await goOffline(boxes[1] as string);
    const [read] = await bellRows();
    expect(read?.title).toMatch(
      /^ISS-1 — No capacity: every runner for this project is out of date$/,
    );
    expect(read?.body).toContain('its one runner is online but running a build older');
    expect(read?.body).toContain('Next: Update forge-runner on that host;');
    expect(read?.body).not.toContain('both');
    const [member] = await membersOf(read?.id as string);
    expect(member?.body).toBe(read?.body);
  });

  it('says no runner is online once neither is', async () => {
    await raiseNotice();
    await goOffline(boxes[0] as string);
    await goOffline(boxes[1] as string);
    const [read] = await bellRows();
    expect(read?.title).toMatch(/^ISS-1 — No capacity: no runner online for this project$/);
    expect(read?.body).toContain('none of its runners are online');
  });

  it('keeps the words it was raised with in the record itself', async () => {
    await raiseNotice();
    await goOffline(boxes[1] as string);
    const [stored] = await harness.db.execute<{ body: string }>(sql`
      SELECT body FROM notifications WHERE type = 'pipeline_wedge' AND project_id = ${projectId}
    `);
    expect(stored?.body).toContain('both of its runners are online');
  });
});
