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

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  const { pairDevice } = await import('../helpers/pair-device.js');
  deviceId = (await pairDevice({ ownerId, name: 'box-b', platform: 'linux' })).device.id;
});

describe('the capacity notice reads the fleet (criterion 176)', () => {
  it('names an online runner without a ready workspace instead of saying none is online', async () => {
    await harness.db.execute(
      sql`UPDATE devices SET agent_version = '0.17.1' WHERE id = ${deviceId}`,
    );
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, name, type, status, last_seen_at, provision_status, provision_status_at)
      VALUES (${randomUUID()}, ${projectId}, ${deviceId}, 'r1', 'claude-code', 'online', now(), 'provisioning', now())
    `);
    const { readCapacityFleet, fleetCopy } = await import('../../src/jobs/capacity-fleet.js');
    const { onlineCapableDeviceIds } = await import('../../src/runners/select.js');
    expect(await onlineCapableDeviceIds(projectId)).toEqual([]);
    const fleet = await readCapacityFleet(projectId, undefined, null);
    expect(fleet.online).toBe(1);
    expect(fleet.bars.workspace).toBe(1);
    const copy = fleetCopy(fleet, { scope: 'this project' });
    expect(copy?.summary).toContain(
      'Its one runner is online, but it is without a workspace ready for this project',
    );
    expect(`${copy?.title} ${copy?.summary}`).not.toMatch(/no runner online/i);
  });

  it('still says no runner is online where none is', async () => {
    const { readCapacityFleet, fleetCopy } = await import('../../src/jobs/capacity-fleet.js');
    const fleet = await readCapacityFleet(projectId, undefined, null);
    expect(fleet.online).toBe(0);
    expect(fleetCopy(fleet, { scope: 'this project' })).toBeNull();
  });
});
