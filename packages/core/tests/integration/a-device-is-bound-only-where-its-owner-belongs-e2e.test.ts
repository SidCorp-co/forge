/**
 * ISS-1236 round 2 — who may have a device bound to a project, and who hears that one is not,
 * against a real Postgres. A project admin could bind any device id, another tenant's included,
 * at both REST doors, and a box could register itself into any project; a binding now needs the
 * account that paired the box to be a member of the project or its organization. A turn that meets
 * an unbound box in a room whose readers cannot act tells the project's admins, once, until it is
 * bound.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };
type Refusal = { code?: string; message?: string; details?: Record<string, unknown> };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  await registerIntegrationsForTest();
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
  (await import('../../src/runners/bootstrap.js')).bootstrapRunnerAdapters();
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let ownerId: string;
let orgId: string;
let projectId: string;
let defaultDeviceId: string;

async function verifiedUser(): Promise<string> {
  const id = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${id}`);
  return id;
}

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = await verifiedUser();
  orgId = (await seedOrg(harness.db, ownerId)).id;
  projectId = (
    await createTestProject(harness.db, ownerId, { slug: 'judge-p', name: 'Judge P', orgId })
  ).id;
  defaultDeviceId = (await createTestDevice(harness.db, ownerId, { name: 'judge-d1' })).id;
  await harness.db.execute(
    sql`UPDATE projects SET default_device_id = ${defaultDeviceId} WHERE id = ${projectId}`,
  );
});

async function as(userId: string, path: string, method = 'GET', body?: unknown): Promise<Response> {
  const { signUserToken } = await import('../../src/auth/jwt.js');
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${await signUserToken(userId)}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function runnerRows(deviceId: string): Promise<number> {
  const rows = await harness.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM runners WHERE device_id = ${deviceId}`,
  );
  return rows[0]?.n ?? 0;
}

describe("the project's admins hear of an unbound device, once, until it is bound", () => {
  async function openNotices(): Promise<Array<{ body: string | null }>> {
    return harness.db.execute<{ body: string | null }>(sql`
      SELECT body FROM notifications
      WHERE resolution_key = ${`device-not-bound:${projectId}:${defaultDeviceId}`}
        AND resolved_at IS NULL
    `) as unknown as Promise<Array<{ body: string | null }>>;
  }

  it('raises one notice naming the device and how to bind it, and a bind resolves it', async () => {
    const { tellAdminsDeviceUnbound } = await import('../../src/devices/unbound-notice.js');
    const refusal = `Device judge-d1 (${defaultDeviceId}) is not bound to project judge-p. Assign the device on judge-p's Runners page.`;
    for (let i = 0; i < 2; i++) {
      await tellAdminsDeviceUnbound({
        projectId,
        deviceId: defaultDeviceId,
        refusal,
        where: 'Forgie in Rocket.Chat',
      });
    }
    const raised = await openNotices();
    expect(raised).toHaveLength(1);
    expect(raised[0]?.body).toContain('judge-d1');
    expect(raised[0]?.body).toContain('Runners page');

    const bound = await as(ownerId, `/api/projects/${projectId}/runners`, 'POST', {
      deviceId: defaultDeviceId,
    });
    expect(bound.status, await bound.clone().text()).toBe(201);
    expect(await openNotices()).toHaveLength(0);
  });

  it.each([
    [
      'POST /api/runners',
      async () => {
        const res = await as(ownerId, '/api/runners', 'POST', {
          projectId,
          type: 'claude-code',
          name: 'judge-d1',
          deviceId: defaultDeviceId,
        });
        expect(res.status, await res.clone().text()).toBe(201);
      },
    ],
    [
      'runner:register',
      async () => {
        const { handleRunnerRegister } = await import('../../src/runners/heartbeat-ws.js');
        const own = { principal: { type: 'device', deviceId: defaultDeviceId, ownerId } };
        await handleRunnerRegister(own as never, {
          data: { type: 'claude-code', name: 'judge-d1', projectId },
        });
      },
    ],
  ])('resolves the notice when the device is bound through %s (review F2)', async (_door, bind) => {
    const { tellAdminsDeviceUnbound } = await import('../../src/devices/unbound-notice.js');
    await tellAdminsDeviceUnbound({
      projectId,
      deviceId: defaultDeviceId,
      refusal: 'Device judge-d1 is not bound to project judge-p.',
      where: 'Forgie in Rocket.Chat',
    });
    expect(await openNotices()).toHaveLength(1);
    await bind();
    expect(await openNotices()).toHaveLength(0);
  });
});

describe('a device another tenant paired is never bound to this project', () => {
  let foreignDeviceId: string;

  beforeEach(async () => {
    const stranger = await verifiedUser();
    await seedOrg(harness.db, stranger);
    foreignDeviceId = (await createTestDevice(harness.db, stranger, { name: 'their-box' })).id;
  });

  it('refuses POST /api/projects/:id/runners DEVICE_NOT_HELD and writes no row', async () => {
    const res = await as(ownerId, `/api/projects/${projectId}/runners`, 'POST', {
      deviceId: foreignDeviceId,
    });
    expect(res.status, await res.clone().text()).toBe(403);
    const body = (await res.json()) as Refusal;
    expect(body.code).toBe('DEVICE_NOT_HELD');
    expect(body.message).toContain(foreignDeviceId);
    expect(await runnerRows(foreignDeviceId)).toBe(0);
  });

  it('refuses POST /api/runners DEVICE_NOT_HELD and writes no row', async () => {
    const res = await as(ownerId, '/api/runners', 'POST', {
      projectId,
      type: 'claude-code',
      name: 'their-box',
      deviceId: foreignDeviceId,
    });
    expect(res.status, await res.clone().text()).toBe(403);
    expect(((await res.json()) as Refusal).code).toBe('DEVICE_NOT_HELD');
    expect(await runnerRows(foreignDeviceId)).toBe(0);
  });

  it("binds a device an organization member paired, though not the caller's own", async () => {
    const colleague = await verifiedUser();
    await harness.db.execute(
      sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${colleague}, 'member')`,
    );
    const theirs = (await createTestDevice(harness.db, colleague, { name: 'colleague-box' })).id;
    const res = await as(ownerId, `/api/projects/${projectId}/runners`, 'POST', {
      deviceId: theirs,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await runnerRows(theirs)).toBe(1);
  });

  it("writes no row for the device's own runner:register into a project its owner holds no place in", async () => {
    const { handleRunnerRegister } = await import('../../src/runners/heartbeat-ws.js');
    const stranger = (
      await harness.db.execute<{ owner_id: string }>(
        sql`SELECT owner_id FROM devices WHERE id = ${foreignDeviceId}`,
      )
    )[0]?.owner_id as string;
    const socket = { principal: { type: 'device', deviceId: foreignDeviceId, ownerId: stranger } };
    await handleRunnerRegister(socket as never, {
      data: { type: 'claude-code', name: 'their-box', projectId },
    });
    expect(await runnerRows(foreignDeviceId)).toBe(0);

    const own = { principal: { type: 'device', deviceId: defaultDeviceId, ownerId } };
    await handleRunnerRegister(own as never, {
      data: { type: 'claude-code', name: 'judge-d1', projectId },
    });
    expect(await runnerRows(defaultDeviceId)).toBe(1);
  });
});
