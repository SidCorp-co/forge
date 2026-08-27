/**
 * ISS-652 — the `adminAlertRoutes` router mounted standalone on a bare Hono
 * app, the way ISS-651's admin-aggregate suite mounts its own.
 *
 * Shared by every `admin-alerts-*-e2e` spec so the env preamble exists once.
 * Order is load-bearing, not style: `config/env.ts` freezes `env` at first
 * import, so `ADMIN_EMAILS` must be set BEFORE the dynamic import below or
 * `requireAdmin` reads an empty allow-list and every request 403s.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import { createTestUser, setupTestDatabase, type TestDatabase } from './index.js';

export const ALERT_ADMIN_EMAIL = 'admin@test.forge.local';

export interface AlertApp {
  harness: TestDatabase;
  app: Hono<{ Variables: RequestIdVars }>;
  verifiedUser(email: string): Promise<{ id: string }>;
  adminToken(): Promise<string>;
}

export async function setupAlertApp(): Promise<AlertApp> {
  const harness = await setupTestDatabase();
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
  process.env.ADMIN_EMAILS = ALERT_ADMIN_EMAIL;

  const { adminAlertRoutes } = await import('../../src/admin/alert-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  const { signUserToken } = await import('../../src/auth/jwt.js');

  const app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/admin', adminAlertRoutes);
  app.onError(errorHandler);

  async function verifiedUser(email: string) {
    const user = await createTestUser(harness.db, { email });
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    return user;
  }

  return {
    harness,
    app,
    verifiedUser,
    async adminToken() {
      const admin = await verifiedUser(ALERT_ADMIN_EMAIL);
      return signUserToken(admin.id);
    },
  };
}

/** Every alert the endpoint returns, in the one shape the specs assert on. */
export type AlertRow = {
  id: string;
  key: string;
  status: string;
  count: number;
  detail: string;
  since: string | null;
  entities: Array<{ ref: string; kind: string; label: string }>;
};

export async function getAlerts(
  ctx: Pick<AlertApp, 'app'>,
  token: string,
  query = '',
): Promise<{ res: Response; body: AlertRow[] }> {
  const res = await ctx.app.request(`/api/admin/alerts${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { res, body: (await res.json()) as AlertRow[] };
}

export const findAlert = (body: AlertRow[], id: string) => body.find((a) => a.id === id);
