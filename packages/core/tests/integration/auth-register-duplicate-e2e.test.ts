/**
 * A second registration of one email answers 409 CONFLICT by name (ISS-34).
 *
 * Against a real Postgres, because the shape is the point: drizzle wraps the driver's error, so
 * the 23505 sits on `cause`, and a reader of `err.code` alone turned it into a 500 whose
 * non-production details carried the failed statement's params, the password hash among them.
 */

import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase, type TestDatabase, truncateAll } from '../helpers/index.js';

describe('POST /api/auth/register for an email already registered', () => {
  let harness: TestDatabase;
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
    const [{ authRoutes }, { errorHandler }] = await Promise.all([
      import('../../src/auth/register.js'),
      import('../../src/middleware/error.js'),
    ]);
    app = new Hono();
    app.route('/api/auth', authRoutes);
    app.onError(errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  const register = (email: string) =>
    app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'quartz-juniper-tessellate' }),
    });

  it('answers 409 CONFLICT, and the body carries no statement, params or hash', async () => {
    expect((await register('dup@example.test')).status).toBe(201);
    const res = await register('dup@example.test');
    const text = await res.text();
    expect(res.status).toBe(409);
    expect(JSON.parse(text)).toEqual({ code: 'CONFLICT', message: 'Email already registered' });
    expect(text).not.toMatch(/\$argon2|params|insert into/i);
  });
});
