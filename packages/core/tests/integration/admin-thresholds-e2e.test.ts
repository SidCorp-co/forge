import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

/**
 * ISS-654 — GET/PUT /api/admin/thresholds against real Postgres.
 *
 * The singleton upsert, the partial patch and the empty-table fallback are all
 * SQL behaviour, so a mocked db proves none of them: the shape this endpoint is
 * most likely to get wrong is a second PUT silently discarding the first one's
 * keys, and only a real round-trip can catch it.
 */
describe('admin thresholds routes (ISS-654)', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

  const ADMIN_EMAIL = 'admin@test.forge.local';

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
    // cm:guard `env.ts` freezes `env` at first import, so ADMIN_EMAILS must be set BEFORE the dynamic import below or requireAdmin sees an empty allow-list and every case 403s
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;

    const { adminThresholdRoutes } = await import('../../src/admin/thresholds-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/admin', adminThresholdRoutes);
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

  async function tokenFor(email: string) {
    return signUserToken((await verifiedUser(email)).id);
  }

  async function get(token: string) {
    return app.request('/api/admin/thresholds', {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function put(token: string, body: unknown) {
    return app.request('/api/admin/thresholds', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('serves the declared defaults while the table is empty', async () => {
    const res = await get(await tokenFor(ADMIN_EMAIL));

    expect(res.status).toBe(200);
    // cm:guard literals, never ADMIN_THRESHOLD_DEFAULTS — an assertion against the implementation's own constant cannot go red on a wrong default
    expect(await res.json()).toEqual({
      stuckJobSeconds: 600,
      runnerStarvedSeconds: 300,
      spendCeilingUsdDay: null,
      spendSpikeMultiple: 2.5,
      scheduleFailStreak: 2,
      deliveryFailRatePct: 20,
      interventionLabels: ['kernel-hardening', 'onboarding'],
      ghostRunnerOfflineDays: 14,
    });
  });

  it('persists a PUT and reads it back', async () => {
    const token = await tokenFor(ADMIN_EMAIL);

    const put1 = await put(token, { spendCeilingUsdDay: 250, stuckJobSeconds: 900 });
    expect(put1.status).toBe(200);

    const body = (await (await get(token)).json()) as Record<string, unknown>;
    expect(body.spendCeilingUsdDay).toBe(250);
    expect(body.stuckJobSeconds).toBe(900);
  });

  // cm:guard the second PUT must not reset the first one's keys — merging over the table defaults instead of over the effective row is the bug this catches.
  it('a second partial PUT keeps the keys the first one set', async () => {
    const token = await tokenFor(ADMIN_EMAIL);

    await put(token, { spendCeilingUsdDay: 250 });
    await put(token, { scheduleFailStreak: 4 });

    const body = (await (await get(token)).json()) as Record<string, unknown>;
    expect(body.spendCeilingUsdDay).toBe(250);
    expect(body.scheduleFailStreak).toBe(4);
  });

  it('keeps exactly one row however many times it is written', async () => {
    const token = await tokenFor(ADMIN_EMAIL);
    await put(token, { stuckJobSeconds: 700 });
    await put(token, { stuckJobSeconds: 800 });

    const rows = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM admin_thresholds`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('clears the ceiling when null is written', async () => {
    const token = await tokenFor(ADMIN_EMAIL);
    await put(token, { spendCeilingUsdDay: 250 });
    await put(token, { spendCeilingUsdDay: null });

    const body = (await (await get(token)).json()) as Record<string, unknown>;
    expect(body.spendCeilingUsdDay).toBeNull();
  });

  it('records who wrote it', async () => {
    const admin = await verifiedUser(ADMIN_EMAIL);
    await put(await signUserToken(admin.id), { stuckJobSeconds: 660 });

    const rows = await harness.db.execute<{ updated_by: string | null }>(
      sql`SELECT updated_by FROM admin_thresholds`,
    );
    expect(rows[0]?.updated_by).toBe(admin.id);
  });

  it('refuses a value outside its range with 400 and writes nothing', async () => {
    const token = await tokenFor(ADMIN_EMAIL);

    expect((await put(token, { spendSpikeMultiple: 0.5 })).status).toBe(400);
    expect((await put(token, { deliveryFailRatePct: 0 })).status).toBe(400);
    expect((await put(token, { ghostRunnerOfflineDays: 0 })).status).toBe(400);

    const rows = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM admin_thresholds`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('refuses an unknown key with 400 rather than dropping it silently', async () => {
    const token = await tokenFor(ADMIN_EMAIL);
    expect((await put(token, { spendCeilingUsdDayy: 100 })).status).toBe(400);
  });

  it('answers 403 to an authenticated non-admin on both verbs', async () => {
    const token = await tokenFor('member@test.forge.local');

    expect((await get(token)).status).toBe(403);
    expect((await put(token, { stuckJobSeconds: 900 })).status).toBe(403);
  });

  it('answers 401 with no credential', async () => {
    expect((await app.request('/api/admin/thresholds')).status).toBe(401);
  });
});
