/**
 * ISS-936 — the settings tab's own GET has to serve the sentence that says what
 * flagging a fact `alwaysInject` does and does not promise.
 *
 * It runs here rather than in the unit lane because the assertion is about the
 * RESPONSE an owner's browser receives, and that response only exists past
 * `requireAuth` + `assertEmailVerified` + the project-membership check, all of
 * which need real rows. A unit test could only re-read the handler's source.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('GET /api/projects/:id/project-facts — the always-inject guarantee (ISS-936)', () => {
  let harness: TestDatabase;
  let guaranteeNote: string;
  let signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
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

    const [routesMod, jwtMod, errMod, factsMod] = await Promise.all([
      import('../../src/projects/routes.js'),
      import('../../src/auth/jwt.js'),
      import('../../src/middleware/error.js'),
      import('../../src/projects/project-facts.js'),
    ]);
    signUserToken = jwtMod.signUserToken;
    guaranteeNote = factsMod.ALWAYS_INJECT_GUARANTEE_NOTE;

    app = new Hono();
    app.route('/api/projects', routesMod.projectRoutes);
    app.onError(errMod.errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  it('serves it to a project member, alongside the char budget', async () => {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });

    const res = await app.request(`/api/projects/${project.id}/project-facts`, {
      headers: { authorization: `Bearer ${await signUserToken(user.id)}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      alwaysInjectGuarantee?: string;
      maxAlwaysInjectChars?: number;
    };
    expect(body.alwaysInjectGuarantee).toBe(guaranteeNote);
    expect(body.maxAlwaysInjectChars).toBe(6000);
  });

  // cm:guard the PATCH answer lands in the same query cache key as the GET's, so a field on only one of them leaves the screen on the owner's first save. Assert BOTH routes or the tab silently loses the sentence.
  it('serves it from the PATCH answer too, which replaces the GET in the browser cache', async () => {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    await harness.db.execute(
      sql`UPDATE organization_members SET role = 'admin' WHERE user_id = ${user.id}`,
    );

    const res = await app.request(`/api/projects/${project.id}/project-facts`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${await signUserToken(user.id)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ projectFacts: { 'build-commands': 'pnpm build' } }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { alwaysInjectGuarantee?: string };
    expect(body.alwaysInjectGuarantee).toBe(guaranteeNote);
  });
});
