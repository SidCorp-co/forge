/**
 * ISS-1315 r4 — a file's teardown ends every connection the file opened before its slot database
 * is handed on. Work the app started during the file (a subscriber's transaction) outlived the
 * close of the app's pool, opened a new one and sat between two statements when the teardown
 * severed it; postgres.js then wrote the next statement to a socket it had dropped, and the
 * process died on `TypeError: Cannot read properties of null (reading 'write')` (run 40339045318).
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { setupTestDatabase } from '../helpers/index.js';

describe('a file that gives its database back', () => {
  it('leaves the app no connection for the teardown to cut off, though its work outlived the file', async () => {
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
    const { db } = await import('../../src/db/client.js');
    await db.execute(sql`SELECT 1`);

    // The work that outlived the file starts once the teardown has closed the app's pool and is
    // ending its own client, and waits on `gate` between its two statements.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let late: Promise<unknown> = Promise.resolve();
    const end = harness.client.end.bind(harness.client);
    harness.client.end = async (options) => {
      late = Promise.resolve().then(() =>
        db.transaction(async (tx) => {
          await tx.execute(sql`SELECT 1`);
          entered();
          await gate;
          await tx.execute(sql`SELECT 2`);
        }),
      );
      await Promise.race([inside, late.catch(() => {})]);
      return end(options);
    };
    const reported = vi.spyOn(console, 'error');

    try {
      await harness.cleanup();
      const outcome = await late.then(
        () => 'committed',
        (err: Error) => err.message,
      );
      release();

      expect(outcome).toContain('closed when the test file gave its database back');
      expect(reported.mock.calls.flat().join('\n')).not.toContain('still open at teardown');
    } finally {
      release();
      reported.mockRestore();
    }
  });
});
