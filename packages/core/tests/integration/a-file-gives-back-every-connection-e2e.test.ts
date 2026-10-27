/**
 * ISS-1315 r4 — a file's teardown ends every connection the file opened before its slot database
 * is handed on. Work the app started during the file (a subscriber's transaction) outlived the
 * close of the app's pool, opened a new one and sat between two statements when the teardown
 * severed it; postgres.js then wrote the next statement to a socket it had dropped, and the
 * process died on `TypeError: Cannot read properties of null (reading 'write')` (run 40339045318).
 *
 * ISS-1315 r7 — a client ended while a statement was running resolves once that statement is done,
 * having only written its goodbye, so the server is still ending the session when the teardown
 * looks; main's CI printed "still open at teardown" for eight files that held nothing that way.
 */

import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { setupTestDatabase } from '../helpers/index.js';

function appEnv(url: string): void {
  process.env.DATABASE_URL = url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
}

describe('a file that gives its database back', () => {
  it('leaves the app no connection for the teardown to cut off, though its work outlived the file', async () => {
    const harness = await setupTestDatabase();
    appEnv(harness.url);
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

  it('runs none of the statements still queued when the app closed its pool, on a connection of its own', async () => {
    const harness = await setupTestDatabase();
    appEnv(harness.url);
    const { db, closeDb } = await import('../../src/db/client.js');
    const reported = vi.spyOn(console, 'error');
    try {
      // More statements than the pool has connections, handed to it now: the tenth on wait in its
      // queue for a connection to come free.
      const client = db.$client;
      const sent = Array.from({ length: 12 }, (_, i) => client`SELECT ${i}::int AS n`.execute());
      const queued = sent[10] as Promise<unknown>;
      for (const statement of sent) statement.catch(() => {});
      await closeDb();

      const outcome = await queued.then(
        () => 'ran after the close',
        (err: Error) => `${err.message} ${String((err.cause as Error | undefined)?.message)}`,
      );
      await harness.cleanup();

      expect(outcome).not.toBe('ran after the close');
      expect(reported.mock.calls.flat().join('\n')).not.toContain('still open at teardown');
    } finally {
      reported.mockRestore();
    }
  });

  it('names nothing for a session still ending because its client was ended under a statement', async () => {
    const harness = await setupTestDatabase();
    const own = postgres(harness.url, { max: 1, onnotice: () => {} });
    const reported = vi.spyOn(console, 'error');
    try {
      // The server drops a session's temporary tables as it ends it, so four hundred of them keep
      // the session listed for most of a second after its client is gone.
      await own.unsafe(
        "DO $$ BEGIN FOR i IN 1..400 LOOP EXECUTE format('CREATE TEMP TABLE plant_%s (id int)', i); END LOOP; END $$",
      );
      const running = own`SELECT count(*) FROM pg_class`.execute();
      await own.end({ timeout: 5 });
      await running;
      const [listed] = await harness.client<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
      `;
      expect(listed?.n, 'the ended session was already gone, so this case shows nothing').toBe(1);

      await harness.cleanup();

      expect(reported.mock.calls.flat().join('\n')).not.toContain('still open at teardown');
    } finally {
      reported.mockRestore();
    }
  });

  it('names what still holds a connection at teardown, by its application and its last statement', async () => {
    const harness = await setupTestDatabase();
    const held = postgres(harness.url, {
      max: 1,
      onnotice: () => {},
      connection: { application_name: 'plant-held-by-this-file' },
    });
    const reported = vi.spyOn(console, 'error');
    try {
      await held`SELECT 'still here' AS plant`;

      await harness.cleanup();

      expect(reported.mock.calls.flat().join('\n')).toMatch(
        /1 connection\(s\) still open at teardown, severed now: pid \d+ plant-held-by-this-file, idle after "SELECT 'still here' AS plant"/,
      );
    } finally {
      reported.mockRestore();
      await held.end({ timeout: 0 }).catch(() => {});
    }
  });
});
