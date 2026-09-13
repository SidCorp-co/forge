/**
 * `POST /api/runners` answers a binding collision with a named 409 (ISS-990).
 *
 * Through the real error middleware, because that is where the shape is
 * decided: `extractCause` forwards `code`, `details` and `wwwAuthenticate` and
 * drops every other key, so a colliding runner attached under any other name
 * leaves the handler and never reaches the caller.
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

describe('POST /api/runners over an existing binding', () => {
  let harness: TestDatabase;
  let mods: Mods;
  // biome-ignore lint/suspicious/noExplicitAny: test-only mount
  let app: any;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';

    const [routesMod, jwtMod, errMod, bootstrapMod] = await Promise.all([
      import('../../src/runners/routes.js'),
      import('../../src/auth/jwt.js'),
      import('../../src/middleware/error.js'),
      import('../../src/runners/bootstrap.js'),
    ]);
    bootstrapMod.bootstrapRunnerAdapters();
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
  });

  async function seed(existingStatus: string) {
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
      INSERT INTO runners (id, project_id, type, device_id, name, capabilities, status)
      VALUES (${runnerId}, ${project.id}, 'claude-code', ${device.id}, 'forge-vm', '{}'::jsonb,
              ${existingStatus})
    `);
    const jwt = await mods.signUserToken(user.id);
    return { user, project, device, runnerId, jwt };
  }

  const register = (s: Awaited<ReturnType<typeof seed>>) =>
    app.request('/api/runners', {
      method: 'POST',
      headers: { authorization: `Bearer ${s.jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: s.project.id,
        type: 'claude-code',
        deviceId: s.device.id,
        name: 'forge-vm again',
      }),
    });

  it('answers 409 with a code a caller can branch on, not a 500', async () => {
    const s = await seed('disabled');

    const res = await register(s);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('RUNNER_ALREADY_BOUND');
  });

  it('names the colliding runner in the message the caller reads', async () => {
    const s = await seed('disabled');

    const body = await (await register(s)).json();

    expect(body.message).toContain(s.runnerId);
    expect(body.message).toMatch(/restore it/i);
  });

  // cm:guard `details` is the ONLY structured channel out — `middleware/error.ts:extractCause` drops every cause key but `code`, `details` and `wwwAuthenticate`, so a runner attached under its own key is silently absent from the response (ISS-990).
  it('carries the colliding runner as structured detail, not only as prose', async () => {
    const s = await seed('disabled');

    const body = await (await register(s)).json();

    expect(body.details?.runner).toMatchObject({ id: s.runnerId, status: 'disabled' });
  });

  it('registers normally when the device has no binding on this project yet', async () => {
    const s = await seed('disabled');
    await harness.db.execute(sql`DELETE FROM runners WHERE id = ${s.runnerId}`);

    const res = await register(s);

    expect(res.status).toBe(201);
  });
});
