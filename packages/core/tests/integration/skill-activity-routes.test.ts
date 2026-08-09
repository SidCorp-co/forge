import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  type TestDatabase,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// cm:why exercises the real route + admin gate — chain-integrity had zero callers outside a unit test on the bare function (ISS-798 review minor).
describe('GET /api/skill-activity/chain-integrity', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

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
    process.env.ADMIN_EMAILS = 'chain-admin@test.forge.local';

    const { skillActivityRoutes } = await import('../../src/skills/activity-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const jwtMod = await import('../../src/auth/jwt.js');
    signUserToken = jwtMod.signUserToken;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/skill-activity', skillActivityRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function verifiedUser(email: string) {
    const user = await createTestUser(harness.db, { email });
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    return user;
  }

  it('403s a non-admin authenticated user', async () => {
    const user = await verifiedUser('nobody@test.forge.local');
    const token = await signUserToken(user.id);

    const res = await app.request('/api/skill-activity/chain-integrity', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('401s an unauthenticated request', async () => {
    const res = await app.request('/api/skill-activity/chain-integrity');
    expect(res.status).toBe(401);
  });

  it('200s a platform-admin user with the integrity report shape', async () => {
    const admin = await verifiedUser('chain-admin@test.forge.local');
    const token = await signUserToken(admin.id);

    const res = await app.request('/api/skill-activity/chain-integrity', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      brokenChains: unknown[];
      skillHashMismatches: unknown[];
      deviceHashMismatches: unknown[];
    };
    expect(body).toMatchObject({
      ok: true,
      brokenChains: [],
      skillHashMismatches: [],
      deviceHashMismatches: [],
    });
  });
});
