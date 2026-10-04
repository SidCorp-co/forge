import { asc, eq, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  type OpenDeviceSocket,
  openDeviceSocket,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

interface FireGround {
  harness: TestDatabase;
  app: Hono<AppVars>;
  m: {
    jwt: typeof import('../../src/auth/jwt.js');
    credential: typeof import('../../src/devices/credential.js');
    schema: typeof import('../../src/db/schema.js');
    routes: typeof import('../../src/schedules/routes.js');
    failover: typeof import('../../src/schedules/failover.js');
    alerts: typeof import('../../src/admin/alert-queries.js');
    thresholds: typeof import('../../src/admin/types.js');
  };
  adminId: string;
  projectId: string;
  boxToken: string;
  sockets: OpenDeviceSocket[];
}

export const g = {} as FireGround;

export function useFireGround(): void {
  beforeAll(async () => {
    g.harness = await setupTestDatabase();
    process.env.DATABASE_URL = g.harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV = 'test';
    process.env.RATE_LIMIT_PAT_READ_MAX = '100000';
    process.env.RATE_LIMIT_PAT_WRITE_MAX = '100000';
    (await import('../../src/integrations/register-all.js')).registerAllIntegrations();
    g.app = (await import('../../src/index.js')).app as unknown as Hono<AppVars>;
    g.m = {
      jwt: await import('../../src/auth/jwt.js'),
      credential: await import('../../src/devices/credential.js'),
      schema: await import('../../src/db/schema.js'),
      routes: await import('../../src/schedules/routes.js'),
      failover: await import('../../src/schedules/failover.js'),
      alerts: await import('../../src/admin/alert-queries.js'),
      thresholds: await import('../../src/admin/types.js'),
    };
  }, 180_000);

  afterAll(async () => {
    await g.harness?.cleanup?.();
  });

  beforeEach(async () => {
    await truncateAll(g.harness.db);
    g.sockets = [];
    g.adminId = (await createTestUser(g.harness.db, { emailVerifiedAt: new Date() })).id;
    const org = await seedOrg(g.harness.db, g.adminId);
    g.projectId = (await createTestProject(g.harness.db, g.adminId, { orgId: org.id })).id;
    await createTestProjectMember(g.harness.db, {
      userId: g.adminId,
      projectId: g.projectId,
      role: 'admin',
    });
    g.boxToken = (
      await boxPairedBy(g.adminId, { turnCredential: true, followUpCredential: true })
    ).token;
  });

  afterEach(() => {
    for (const s of g.sockets) s.close();
  });
}

export async function boxPairedBy(holder: string, capabilities: Record<string, boolean>) {
  const device = await createTestDevice(g.harness.db, holder);
  await bindTestRunner(g.harness.db, { projectId: g.projectId, deviceId: device.id });
  await g.harness.db.execute(sql`UPDATE runners SET last_seen_at = now()`);
  await g.harness.db.execute(
    sql`UPDATE devices SET capabilities = ${JSON.stringify(capabilities)}::jsonb WHERE id = ${device.id}`,
  );
  const token = await g.m.credential.issueDeviceCredential({
    deviceId: device.id,
    holderUserId: holder,
  });
  const opened = openDeviceSocket(device.id);
  g.sockets.push(opened);
  return { id: device.id, token, socket: opened };
}

export function call(method: string, path: string, bearer: string, body?: unknown) {
  return g.app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function adminBearer(): Promise<string> {
  return g.m.jwt.signUserToken(g.adminId);
}

export async function createSchedule(body: Record<string, unknown>): Promise<string> {
  const res = await call('POST', '/api/schedules', await adminBearer(), {
    projectId: g.projectId,
    name: 'fire subject',
    cron: '0 3 * * *',
    ...body,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

export async function tick(scheduleId: string): Promise<void> {
  const now = new Date();
  await g.harness.db
    .update(g.m.schema.schedules)
    .set({ nextRunAt: new Date(now.getTime() - 60_000) })
    .where(eq(g.m.schema.schedules.id, scheduleId));
  await g.m.routes.runScheduleTickOnce(now);
}

export async function firesOf(scheduleId: string) {
  return g.harness.db
    .select()
    .from(g.m.schema.scheduleRuns)
    .where(eq(g.m.schema.scheduleRuns.scheduleId, scheduleId))
    .orderBy(asc(g.m.schema.scheduleRuns.createdAt));
}

export async function onlyFire(scheduleId: string) {
  const fires = await firesOf(scheduleId);
  expect(fires).toHaveLength(1);
  return fires[0] as (typeof fires)[number];
}

export async function scheduleRow(scheduleId: string) {
  const [row] = await g.harness.db
    .select()
    .from(g.m.schema.schedules)
    .where(eq(g.m.schema.schedules.id, scheduleId));
  if (!row) throw new Error(`schedule ${scheduleId} is gone`);
  return row;
}

export async function sessionRow(sessionId: string) {
  const [row] = await g.harness.db
    .select()
    .from(g.m.schema.agentSessions)
    .where(eq(g.m.schema.agentSessions.id, sessionId));
  if (!row) throw new Error(`session ${sessionId} is gone`);
  return row;
}
