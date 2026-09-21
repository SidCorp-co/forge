/**
 * ISS-1027 — `GET /api/runners/:id/activity` answers with the window its own
 * events are kept for, and the panel renders that number rather than a literal.
 *
 * The field exists so an operator who moves `RETENTION_RUNNER_EVENTS_DAYS`
 * reads the truth on the screen instead of a number typed into a component
 * once. That is a contract between two packages, so it is asserted here rather
 * than left to the render test on the other side of it: web-v2 rendering
 * `retentionDays` faithfully proves nothing if this route stops sending it.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  runnerRoutes: typeof import('../../src/runners/routes.js').runnerRoutes;
  signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  errorHandler: typeof import('../../src/middleware/error.js').errorHandler;
};

type ActivityBody = {
  events: unknown[];
  sessions: unknown[];
  retentionDays: number | null;
};

describe('GET /api/runners/:id/activity — the retention window (ISS-1027)', () => {
  let harness: TestDatabase;
  let mods: Mods;
  // biome-ignore lint/suspicious/noExplicitAny: test-only mount
  let app: any;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';

    const [routesMod, jwtMod, errMod] = await Promise.all([
      import('../../src/runners/routes.js'),
      import('../../src/auth/jwt.js'),
      import('../../src/middleware/error.js'),
    ]);
    mods = {
      runnerRoutes: routesMod.runnerRoutes,
      signUserToken: jwtMod.signUserToken,
      errorHandler: errMod.errorHandler,
    };
    app = new Hono();
    app.route('/api/runners', mods.runnerRoutes);
    app.onError(mods.errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    delete process.env.RETENTION_RUNNER_EVENTS_DAYS;
  });

  async function seedRunner() {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    const device = await createTestDevice(harness.db, user.id);
    const runnerId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status)
      VALUES (${runnerId}, ${project.id}, 'claude-code', ${device.id}, 'box', 'online')
    `);
    return { runnerId, jwt: await mods.signUserToken(user.id) };
  }

  async function call(runnerId: string, jwt: string) {
    const res = await app.request(`/api/runners/${runnerId}/activity`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as ActivityBody };
  }

  it('answers with the stated window when nothing overrides it', async () => {
    const { runnerId, jwt } = await seedRunner();

    const { status, body } = await call(runnerId, jwt);

    expect(status).toBe(200);
    expect(body.retentionDays).toBe(90);
  });

  it('answers with an operator override, so the panel names what is actually kept', async () => {
    process.env.RETENTION_RUNNER_EVENTS_DAYS = '120';
    const { runnerId, jwt } = await seedRunner();

    expect((await call(runnerId, jwt)).body.retentionDays).toBe(120);
  });

  it('answers with the floor, not a below-floor override the sweep refuses', async () => {
    process.env.RETENTION_RUNNER_EVENTS_DAYS = '5';
    const { runnerId, jwt } = await seedRunner();

    expect((await call(runnerId, jwt)).body.retentionDays).toBe(90);
  });
});
