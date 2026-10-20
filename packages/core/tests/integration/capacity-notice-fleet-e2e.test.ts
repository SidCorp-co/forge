/**
 * ISS-1228 round 19 (judge-57) — the bell said "No capacity: no runner online" while a box was online.
 * The notice reads the project's runner rows the fleet shows online and names what keeps each from
 * the step, saying none is online only where none is.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
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
let deviceId: string;
let ownerId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  const { pairDevice } = await import('../helpers/pair-device.js');
  deviceId = (await pairDevice({ ownerId, name: 'box-b', platform: 'linux' })).device.id;
});

async function failedJob(): Promise<typeof import('../../src/db/schema.js').jobs.$inferSelect> {
  const jobId = randomUUID();
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${projectId}, 'pm', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status, payload, finished_at, error, failure_action)
    VALUES (${jobId}, ${projectId}, ${runId}, ${ownerId}, 'drive', 'failed', '{"promptString":"go"}'::jsonb, now(),
            'infra: connection reset', 'retry')
  `);
  const { db } = await import('../../src/db/client.js');
  const { jobs } = await import('../../src/db/schema.js');
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!row) throw new Error('planted job vanished');
  return row;
}

async function bell(): Promise<Array<{ title: string; body: string | null }>> {
  return (await harness.db.execute(sql`
    SELECT title, body FROM notifications WHERE type = 'pipeline_wedge' AND project_id = ${projectId}
  `)) as unknown as Array<{ title: string; body: string | null }>;
}

async function runner(provision: string | null): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, name, type, status, last_seen_at, provision_status,
                         provision_status_at)
    VALUES (${randomUUID()}, ${projectId}, ${deviceId}, 'r1', 'claude-code', 'online', now(), ${provision},
            ${provision ? sql`now()` : null})
  `);
}

describe('the capacity notice reads the fleet (criterion 176)', () => {
  it('names an online runner without a ready workspace instead of saying none is online', async () => {
    await runner('provisioning');
    const { onlineCapableDeviceIds } = await import('../../src/runners/select.js');
    expect(await onlineCapableDeviceIds(projectId)).toEqual([]);

    const { scheduleAutoRetryWithVerify } = await import('../../src/jobs/retry.js');
    await scheduleAutoRetryWithVerify(await failedJob(), 'infra: connection reset');

    const [notice] = await bell();
    expect(notice?.title).toMatch(/ — No runner can take this work for this project$/);
    expect(notice?.body).toContain(
      'Its one runner is online, but it is without a workspace ready for this project.',
    );
    expect(`${notice?.title} ${notice?.body}`).not.toMatch(
      /no runner online|none of its runners are online/i,
    );
  });

  it('still says no runner is online where none is', async () => {
    const { scheduleAutoRetryWithVerify } = await import('../../src/jobs/retry.js');
    await scheduleAutoRetryWithVerify(await failedJob(), 'infra: connection reset');
    const [notice] = await bell();
    expect(notice?.title).toMatch(/ — No capacity: no runner online for this project$/);
  });

  it('reads each runner the fleet counts, naming a turned-off box beside one without a workspace', async () => {
    await runner('provisioning');
    const { pairDevice } = await import('../helpers/pair-device.js');
    const second = (await pairDevice({ ownerId, name: 'box-c', platform: 'linux' })).device.id;
    await harness.db.execute(sql`UPDATE devices SET disabled_at = now() WHERE id = ${second}`);
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, name, type, status, last_seen_at)
      VALUES (${randomUUID()}, ${projectId}, ${second}, 'r2', 'claude-code', 'online', now())
    `);
    const { readCapacityFleet, fleetCopy } = await import('../../src/jobs/capacity-fleet.js');
    const fleet = await readCapacityFleet(projectId, undefined, null);
    expect(fleet.online).toBe(2);
    expect(fleet.bars).toMatchObject({ disabled: 1, workspace: 1 });
    expect(fleetCopy(fleet, { scope: 'this project' })?.summary).toContain(
      'Both of its runners are online, but one is turned off, and one is without a workspace ready for this project.',
    );
  });
});
