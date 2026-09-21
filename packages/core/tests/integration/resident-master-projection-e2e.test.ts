/**
 * ISS-1118 — whether a bound box holds a resident master for a project,
 * answered by the row the project Runners screen already reads.
 *
 * Against real Postgres, because the whole thing is one correlated subquery
 * over `jsonb`, a `NOT IN` on the terminal statuses and a shape that must not
 * drop a runner row. A mocked db returns whatever it is fed and is no evidence
 * about any of the three.
 *
 * What is proved here is a REGISTRATION, which is what core holds: the box
 * told core it was running a master and has not told core it stopped. Core
 * cannot see tmux, so the heartbeat is the only thing separating a master
 * working now from one whose box went quiet, and the screen says which.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let ensureMasterSession: typeof import('../../src/devices/master-session.js').ensureMasterSession;
let closeMasterSession: typeof import('../../src/devices/master-session.js').closeMasterSession;
let residentMasterSql: typeof import('../../src/devices/master-session.js').residentMasterSql;
let runnersTable: typeof import('../../src/db/schema.js').runners;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  const masterSession = await import('../../src/devices/master-session.js');
  ensureMasterSession = masterSession.ensureMasterSession;
  closeMasterSession = masterSession.closeMasterSession;
  residentMasterSql = masterSession.residentMasterSql;
  ({ runners: runnersTable } = await import('../../src/db/schema.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function seed() {
  const owner = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, owner.id);
  const device = await createTestDevice(harness.db, owner.id);
  const runnerId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, type, name, status, last_seen_at)
    VALUES (${runnerId}, ${project.id}, ${device.id}, 'claude-code', 'box-1', 'online', now())
  `);
  return { owner, project, device, runnerId };
}

/** The projection, read exactly as the project Runners route reads it. */
async function readRows() {
  return (await harness.db
    .select({
      runnerId: runnersTable.id,
      residentMaster: residentMasterSql(runnersTable.deviceId, runnersTable.projectId),
    })
    .from(runnersTable)) as unknown as Array<{
    runnerId: string;
    residentMaster: { sessionId: string; name: string; lastHeartbeatAt: string | null } | null;
  }>;
}

describe('the resident-master projection on a runner row (ISS-1118)', () => {
  it('answers null for a bound box that has registered no master, without dropping its row', async () => {
    const { runnerId } = await seed();

    const rows = await readRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.runnerId).toBe(runnerId);
    expect(rows[0]?.residentMaster).toBeNull();
  });

  it('names the master session and its terminal once the box registers one', async () => {
    const { project, device, runnerId } = await seed();

    const registered = await ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'forge-master-judgeproj',
    });

    const rows = await readRows();
    expect(rows[0]?.runnerId).toBe(runnerId);
    expect(rows[0]?.residentMaster?.sessionId).toBe(registered.sessionId);
    expect(rows[0]?.residentMaster?.name).toBe('forge-master-judgeproj');
    expect(rows[0]?.residentMaster?.lastHeartbeatAt).toBeTruthy();
  });

  it('goes back to null when the box reports the pane gone', async () => {
    const { project, device } = await seed();
    const registered = await ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'forge-master-judgeproj',
    });
    expect((await readRows())[0]?.residentMaster).not.toBeNull();

    await closeMasterSession({
      deviceId: device.id,
      sessionId: registered.sessionId,
      reason: 'resident session is gone',
    });

    expect((await readRows())[0]?.residentMaster).toBeNull();
  });

  it('does not answer with another project’s master on the same device', async () => {
    const { owner, device } = await seed();
    const other = await createTestProject(harness.db, owner.id);
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, type, name, status, last_seen_at)
      VALUES (${randomUUID()}, ${other.id}, ${device.id}, 'claude-code', 'box-1', 'online', now())
    `);

    await ensureMasterSession({
      deviceId: device.id,
      projectId: other.id,
      name: 'forge-master-other',
    });

    const rows = await readRows();
    const named = rows.filter((r) => r.residentMaster !== null);
    expect(named).toHaveLength(1);
    expect(named[0]?.residentMaster?.name).toBe('forge-master-other');
  });

  it('does not answer with the same project’s master on a different device', async () => {
    const { owner, project } = await seed();
    const otherDevice = await createTestDevice(harness.db, owner.id);
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, type, name, status, last_seen_at)
      VALUES (${randomUUID()}, ${project.id}, ${otherDevice.id}, 'claude-code', 'box-2', 'online', now())
    `);

    await ensureMasterSession({
      deviceId: otherDevice.id,
      projectId: project.id,
      name: 'forge-master-on-box-2',
    });

    const rows = await readRows();
    const named = rows.filter((r) => r.residentMaster !== null);
    expect(named).toHaveLength(1);
    expect(named[0]?.residentMaster?.name).toBe('forge-master-on-box-2');
  });
});
