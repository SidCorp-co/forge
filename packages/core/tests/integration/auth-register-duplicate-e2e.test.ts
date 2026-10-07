/**
 * A second registration of one email answers 409 CONFLICT by name, and a failed statement's bound
 * values reach no response and no log line (ISS-1383).
 *
 * Against a real Postgres, because the shape is the point: drizzle wraps the driver's error, so
 * the 23505 sits on `cause`, and the failed statement's params ride on the wrapper's message.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { type LoggerOptions, pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase, type TestDatabase, truncateAll } from '../helpers/index.js';

const PASSWORD = 'quartz-juniper-tessellate';
const EMAIL = 'dup@example.test';

describe('POST /api/auth/register for an email already registered', () => {
  let harness: TestDatabase;
  // biome-ignore lint/suspicious/noExplicitAny: test-only mount
  let app: any;
  let loggerOptions: LoggerOptions;
  let isUniqueViolation: (err: unknown) => boolean;

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
    const [{ authRoutes }, { errorHandler }, logger, dbErrors] = await Promise.all([
      import('../../src/auth/register.js'),
      import('../../src/middleware/error.js'),
      import('../../src/logger.js'),
      import('../../src/lib/db-errors.js'),
    ]);
    loggerOptions = logger.loggerOptions;
    isUniqueViolation = dbErrors.isUniqueViolation;
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
      body: JSON.stringify({ email, password: PASSWORD }),
    });

  /** What the database itself throws for a second row with this email, through drizzle. */
  async function duplicateInsert(): Promise<unknown> {
    const insert = sql`insert into users (email, password_hash) values (${EMAIL}, ${'$argon2id$synthetic-e2e-hash-value'})`;
    await harness.db.execute(insert);
    return harness.db.execute(insert).then(
      () => expect.unreachable('the second insert was accepted'),
      (err: unknown) => err,
    );
  }

  it('answers 409 CONFLICT, and the body carries no statement, params or hash', async () => {
    expect((await register(EMAIL)).status).toBe(201);
    const res = await register(EMAIL);
    const text = await res.text();
    expect(res.status).toBe(409);
    expect(JSON.parse(text)).toEqual({ code: 'CONFLICT', message: 'Email already registered' });
    expect(text).not.toMatch(/\$argon2|params|insert into/i);
  });

  it("reads the driver's unique violation through drizzle's wrapper and one more", async () => {
    const err = await duplicateInsert();
    expect(isUniqueViolation(err)).toBe(true);
    expect(isUniqueViolation(new Error('register failed', { cause: err }))).toBe(true);
  });

  it("logs the database's refusal by statement, SQLSTATE and constraint, and none of its values", async () => {
    const err = await duplicateInsert();
    const lines: string[] = [];
    const log = pino(loggerOptions, { write: (s: string) => lines.push(s) });
    log.error({ err });
    log.error(err as Error, 'http.unhandled');
    log.warn({ error: err }, 'wrapped');

    for (const line of lines) {
      expect(line).not.toContain('synthetic-e2e-hash-value');
      expect(line).not.toContain(EMAIL);
    }
    const first = JSON.parse(lines[0] ?? '');
    expect(first.err.sqlstate).toBe('23505');
    expect(first.err.constraint).toBe('users_email_unique');
    expect(first.err.message).toContain('violates unique constraint "users_email_unique"');
  });

  it('withholds a driver message that repeats a short bound value', async () => {
    const err = await harness.db.execute(sql`select ${'zq9'}::uuid`).then(
      () => expect.unreachable('zq9 was read as a uuid'),
      (e: unknown) => e,
    );
    const lines: string[] = [];
    const log = pino(loggerOptions, { write: (s: string) => lines.push(s) });
    log.error({ err });
    log.error({ err: (err as Error).message });
    log.error({ err: ((err as Error).cause as Error).message });
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).not.toContain('zq9');
    expect(JSON.parse(lines[0] ?? '').err.sqlstate).toBe('22P02');
  });
});
