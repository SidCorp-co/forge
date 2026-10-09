/**
 * A provision that stopped advancing is stalled, and says so (ISS-1359).
 *
 * anhome's release was refused for a box that was running anhome's master: the
 * runner row read `cloning` with no `provisioned_at`, nothing on the box was
 * advancing it, and every reader treated `cloning` as in progress for ever. Real
 * Postgres is the point — the dispatch filter, the release hold and the pull
 * endpoint all decide in SQL, and a mocked `db` cannot represent any of them.
 *
 * The sentences each criterion rests on are asserted against the rows the real
 * routes and queries answer, with the row's age set the only way the product sets
 * it: by writing `provision_status_at`, never by faking a clock.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

const MIN = 60_000;

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let schema: typeof import('../../src/db/schema.js');
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let pairDevice: typeof import('../helpers/pair-device.js').pairDevice;
let ensureMasterSession: typeof import('../../src/devices/master-session.js').ensureMasterSession;
let onlineCapableDeviceIds: typeof import('../../src/runners/select.js').onlineCapableDeviceIds;
let releaseIneligibleRunners: typeof import('../../src/runners/ineligible.js').releaseIneligibleRunners;
let handleRunnerRegister: typeof import('../../src/runners/heartbeat-ws.js').handleRunnerRegister;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-abc';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const [provisions, deviceRoutes, tab, auth, err, requestId, jwt] = await Promise.all([
    import('../../src/devices/me-provisions.js'),
    import('../../src/devices/routes.js'),
    import('../../src/projects/runners-routes.js'),
    import('../../src/middleware/auth.js'),
    import('../../src/middleware/error.js'),
    import('../../src/middleware/request-id.js'),
    import('../../src/auth/jwt.js'),
  ]);
  schema = await import('../../src/db/schema.js');
  signUserToken = jwt.signUserToken;
  pairDevice = (await import('../helpers/pair-device.js')).pairDevice;
  ensureMasterSession = (await import('../../src/devices/master-session.js')).ensureMasterSession;
  onlineCapableDeviceIds = (await import('../../src/runners/select.js')).onlineCapableDeviceIds;
  releaseIneligibleRunners = (await import('../../src/runners/ineligible.js'))
    .releaseIneligibleRunners;
  handleRunnerRegister = (await import('../../src/runners/heartbeat-ws.js')).handleRunnerRegister;

  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId.requestId());
  app.route('/api/devices', provisions.deviceProvisionRoutes);
  app.route('/api/devices', deviceRoutes.deviceAuthRoutes);
  const runnersTab = new Hono();
  runnersTab.use('*', auth.requireAuth(), auth.assertEmailVerified());
  runnersTab.route('/', tab.projectRunnerRoutes);
  app.route('/api/projects', runnersTab);
  app.onError(err.errorHandler);
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

interface World {
  userId: string;
  projectId: string;
  deviceId: string;
  deviceName: string;
  deviceToken: string;
  runnerId: string;
  userToken: string;
}

/** One box, one project, and a runner row that heartbeats and reads `status` as of `minutesAgo`. */
async function seed(status: string, minutesAgo: number, detail: string | null = null) {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  const { device, plaintext } = await pairDevice({
    ownerId: user.id,
    name: 'sid-xeon-1',
    platform: 'linux',
  });
  await harness.db.execute(
    sql`UPDATE devices SET agent_version = '99.0.0', status = 'online' WHERE id = ${device.id}`,
  );
  const runnerId = randomUUID();
  const at = new Date(Date.now() - minutesAgo * MIN).toISOString();
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at,
                         provision_status, provision_detail, provision_requested_at, provision_status_at)
    VALUES (${runnerId}, ${project.id}, 'claude-code', ${device.id}, 'sid-xeon-1', 'online', now(),
            ${status}, ${detail}, ${at}::timestamptz, ${at}::timestamptz)
  `);
  const w: World = {
    userId: user.id,
    projectId: project.id,
    deviceId: device.id,
    deviceName: 'sid-xeon-1',
    deviceToken: plaintext,
    runnerId,
    userToken: await signUserToken(user.id),
  };
  return w;
}

const withMaster = (w: World) =>
  ensureMasterSession({
    deviceId: w.deviceId,
    projectId: w.projectId,
    name: 'forge-master-anhome',
  });

const pull = async (w: World) => {
  const res = await app.request('/api/devices/me/provisions', {
    headers: { authorization: `Bearer ${w.deviceToken}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Array<{ runnerId: string }>;
};

const stampOf = async (runnerId: string) => {
  const [row] = await harness.db
    .select({ at: schema.runners.provisionStatusAt, status: schema.runners.provisionStatus })
    .from(schema.runners)
    .where(eq(schema.runners.id, runnerId));
  return row as { at: Date; status: string };
};

describe('what release admission and dispatch read of a stalled provision (criteria 1-4)', () => {
  it('holds a cloning row two hours old as stalled, with its age', async () => {
    const w = await seed('cloning', 120);

    const holds = await releaseIneligibleRunners(w.projectId);

    expect(holds).toHaveLength(1);
    expect(holds[0]?.reason).toBe('provision-stalled');
    expect(holds[0]?.stalledSeconds).toBeGreaterThanOrEqual(7200);
    expect(holds[0]?.detail).toBe('cloning');
    expect(await onlineCapableDeviceIds(w.projectId, {})).toEqual([]);
  });

  it('keeps a provision ten minutes in as in progress, held and not called stalled', async () => {
    const w = await seed('cloning', 10);

    const holds = await releaseIneligibleRunners(w.projectId);

    expect(holds.map((h) => h.reason)).toEqual(['provisioning']);
    expect(await onlineCapableDeviceIds(w.projectId, {})).toEqual([]);
  });

  it.each(['failed', 'needs_manual_setup'])(
    'holds %s as the box reported it, however long ago',
    async (status) => {
      const w = await seed(status, 60 * 24 * 90, 'git clone failed');

      expect((await releaseIneligibleRunners(w.projectId)).map((h) => h.reason)).toEqual([
        'provisioning',
      ]);
      expect(await onlineCapableDeviceIds(w.projectId, {})).toEqual([]);
    },
  );

  it('takes the box for dispatch and for release when it holds the project’s live master, which is the anhome case', async () => {
    const w = await seed('cloning', 60 * 24 * 9);
    await withMaster(w);

    expect(await onlineCapableDeviceIds(w.projectId, {})).toEqual([w.deviceId]);
    expect(await releaseIneligibleRunners(w.projectId)).toEqual([]);

    // The row still says what it says; only the refusal is lifted.
    const listed = await app.request(`/api/projects/${w.projectId}/runners`, {
      headers: { Authorization: `Bearer ${w.userToken}` },
    });
    const [row] = (await listed.json()) as Array<{
      provisionStatus: string;
      provisionStalledSeconds: number | null;
      residentMaster: { name: string } | null;
    }>;
    expect(row?.provisionStatus).toBe('cloning');
    expect(row?.provisionStalledSeconds).toBeGreaterThanOrEqual(9 * 86400);
    expect(row?.residentMaster?.name).toBe('forge-master-anhome');
  });

  it('does not let a live master excuse a provision that began a minute ago', async () => {
    const w = await seed('cloning', 1);
    await withMaster(w);

    expect(await onlineCapableDeviceIds(w.projectId, {})).toEqual([]);
    expect((await releaseIneligibleRunners(w.projectId)).map((h) => h.reason)).toEqual([
      'provisioning',
    ]);
  });

  it('refuses the same stalled row again once the master has ended', async () => {
    const w = await seed('writing_mcp', 300);
    const master = await withMaster(w);
    expect(await onlineCapableDeviceIds(w.projectId, {})).toEqual([w.deviceId]);

    await harness.db.execute(
      sql`UPDATE agent_sessions SET status = 'completed' WHERE id = ${master.sessionId}`,
    );

    expect(await onlineCapableDeviceIds(w.projectId, {})).toEqual([]);
    expect((await releaseIneligibleRunners(w.projectId)).map((h) => h.reason)).toEqual([
      'provision-stalled',
    ]);
  });

  it('leaves a ready row and a row that never declared a status unheld', async () => {
    const ready = await seed('ready', 60 * 24 * 30);
    expect(await onlineCapableDeviceIds(ready.projectId, {})).toEqual([ready.deviceId]);

    await truncateAll(harness.db);
    const legacy = await seed('ready', 0);
    await harness.db.execute(
      sql`UPDATE runners SET provision_status = NULL WHERE id = ${legacy.runnerId}`,
    );
    expect(await onlineCapableDeviceIds(legacy.projectId, {})).toEqual([legacy.deviceId]);
  });
});

describe('what GET /me/provisions offers (criterion 5)', () => {
  it.each(['cloning', 'syncing_skills', 'writing_mcp'])(
    'offers a %s row that stood past the window, so the box re-runs it',
    async (status) => {
      const w = await seed(status, 90);

      expect((await pull(w)).map((p) => p.runnerId)).toEqual([w.runnerId]);
    },
  );

  it('does not offer a row inside the window, where the box may be mid-clone', async () => {
    const w = await seed('cloning', 5);

    expect(await pull(w)).toEqual([]);
  });

  it('does not offer a settled row', async () => {
    const w = await seed('failed', 60 * 24 * 30);

    expect(await pull(w)).toEqual([]);
  });

  it('withholds a stalled row, and a queued one, while the device holds the project’s live master', async () => {
    const w = await seed('cloning', 90);
    await withMaster(w);
    expect(await pull(w)).toEqual([]);

    await harness.db.execute(
      sql`UPDATE runners SET provision_status = 'queued', provision_status_at = now() WHERE id = ${w.runnerId}`,
    );
    expect(await pull(w)).toEqual([]);
  });

  it('still offers a freshly queued row where no master is live, as it always did', async () => {
    const w = await seed('queued', 0);

    expect((await pull(w)).map((p) => p.runnerId)).toEqual([w.runnerId]);
  });
});

describe('what stamps a provision’s age (criterion 6)', () => {
  it('stamps the box’s own report, and a heartbeat afterwards does not move it', async () => {
    const w = await seed('cloning', 120);
    const before = await stampOf(w.runnerId);

    const res = await app.request(`/api/devices/me/runners/${w.runnerId}/provision-status`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${w.deviceToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'syncing_skills' }),
    });
    expect(res.status).toBe(200);
    const reported = await stampOf(w.runnerId);
    expect(reported.at.getTime()).toBeGreaterThan(before.at.getTime() + 100 * MIN);

    await handleRunnerRegister(
      {
        principal: { type: 'device', deviceId: w.deviceId, ownerId: w.userId },
        send: () => undefined,
      } as never,
      { data: { type: 'claude-code', name: 'sid-xeon-1', projectId: w.projectId } },
    );
    const [afterHeartbeat] = await harness.db.execute<{ moved: boolean }>(sql`
      SELECT updated_at > provision_status_at AS moved FROM runners WHERE id = ${w.runnerId}
    `);
    expect(afterHeartbeat?.moved).toBe(true);
    expect((await stampOf(w.runnerId)).at.getTime()).toBe(reported.at.getTime());
  });

  it('stamps a bind, which re-queues the provision', async () => {
    const w = await seed('failed', 600);

    const res = await app.request(`/api/projects/${w.projectId}/runners`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${w.userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: w.deviceId }),
    });

    expect(res.status).toBe(201);
    const row = await stampOf(w.runnerId);
    expect(row.status).toBe('queued');
    expect(Date.now() - row.at.getTime()).toBeLessThan(2 * MIN);
  });
});

describe('re-provisioning a workspace a master is running in (criterion 7)', () => {
  it('is refused by name, and writes nothing', async () => {
    const w = await seed('failed', 600, 'git clone failed');
    await harness.db.execute(
      sql`UPDATE runners SET repo_path = '/srv/anhome', branch = 'release/stg' WHERE id = ${w.runnerId}`,
    );
    const master = await withMaster(w);
    const before = await stampOf(w.runnerId);

    const res = await app.request(`/api/projects/${w.projectId}/runners`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${w.userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: w.deviceId, repoPath: '/elsewhere', branch: 'main' }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe('PROVISION_WORKSPACE_IN_USE');
    expect(body.message).toContain('forge-master-anhome');
    expect(body.message).toContain('sid-xeon-1');

    const [row] = await harness.db
      .select({
        status: schema.runners.provisionStatus,
        repoPath: schema.runners.repoPath,
        branch: schema.runners.branch,
        at: schema.runners.provisionStatusAt,
      })
      .from(schema.runners)
      .where(eq(schema.runners.id, w.runnerId));
    expect(row?.status).toBe('failed');
    expect(row?.repoPath).toBe('/srv/anhome');
    expect(row?.branch).toBe('release/stg');
    expect(row?.at.getTime()).toBe(before.at.getTime());

    // And is accepted once the master has ended, which is what the message asks of the operator.
    await harness.db.execute(
      sql`UPDATE agent_sessions SET status = 'completed' WHERE id = ${master.sessionId}`,
    );
    const again = await app.request(`/api/projects/${w.projectId}/runners`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${w.userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: w.deviceId }),
    });
    expect(again.status).toBe(201);
  });

  it('leaves a device with no master, or a master for another project, free to bind', async () => {
    const w = await seed('failed', 600);
    const other = await createTestProject(harness.db, w.userId);
    await ensureMasterSession({
      deviceId: w.deviceId,
      projectId: other.id,
      name: 'forge-master-other',
    });

    const res = await app.request(`/api/projects/${w.projectId}/runners`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${w.userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: w.deviceId }),
    });

    expect(res.status).toBe(201);
  });
});

describe('what the migration does to the rows it finds (criterion 9)', () => {
  const migration = readFileSync(
    new URL('../../drizzle/migrations/0326_a_provision_has_an_age.sql', import.meta.url),
    'utf8',
  );

  it('dates no existing row earlier than the migration, so none reads stalled before a window has passed', async () => {
    expect(migration).not.toMatch(/^\s*UPDATE\b/im);
    const stuck = await seed('cloning', 0);
    await harness.db.execute(sql`
      UPDATE runners SET provision_requested_at = now() - interval '9 days', provision_status_at = DEFAULT
       WHERE id = ${stuck.runnerId}
    `);

    expect((await releaseIneligibleRunners(stuck.projectId)).map((h) => h.reason)).toEqual([
      'provisioning',
    ]);

    await harness.db.execute(
      sql`UPDATE runners SET provision_status_at = now() - interval '31 minutes' WHERE id = ${stuck.runnerId}`,
    );
    expect((await releaseIneligibleRunners(stuck.projectId)).map((h) => h.reason)).toEqual([
      'provision-stalled',
    ]);
  });

  it('leaves a ready row unheld however old its provision', async () => {
    const ready = await seed('ready', 60 * 24 * 40);

    expect(await releaseIneligibleRunners(ready.projectId)).toEqual([]);
  });
});
