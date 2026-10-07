/**
 * A failed statement's error leaves core's database client with none of its bound values in its
 * message, its stack or anything it serializes as, in a transaction or out of one (ISS-1383).
 *
 * Against a real Postgres through core's own `db`, because what is sealed is what drizzle and the
 * driver build: a SQLSTATE on `cause`, the input quoted in the driver's message, `detail` and `where`.
 */

import { REDACTED } from '@forge/observability';
import { sql } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDatabase, type TestDatabase } from '../helpers/index.js';

const VALUE = 'zq9-sealed-bound-value';

describe("core's database client, given a statement the database refuses", () => {
  let harness: TestDatabase;
  let db: typeof import('../../src/db/client.js')['db'];
  let isUniqueViolation: (err: unknown) => boolean;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    const [client, dbErrors] = await Promise.all([
      import('../../src/db/client.js'),
      import('../../src/lib/db-errors.js'),
    ]);
    db = client.db;
    isUniqueViolation = dbErrors.isUniqueViolation;
    await harness.client.unsafe(
      'create table seal_probe (v text, constraint seal_probe_v_key unique (v) deferrable initially deferred)',
    );
  }, 60_000);

  afterAll(async () => {
    await (await import('../../src/db/client.js')).closeDb();
    if (harness) await harness.cleanup();
  });

  async function caught(run: () => Promise<unknown>): Promise<Error> {
    return run().then(
      () => expect.unreachable('the database accepted it'),
      (e: unknown) => e as Error,
    );
  }

  /** Every surface a caller could copy text out of, as one string. */
  function everyCopy(err: Error): string {
    const cause = err.cause as Error | undefined;
    return [
      err.message,
      err.stack,
      String(err),
      JSON.stringify(err),
      cause?.message,
      cause?.stack,
      JSON.stringify(cause),
    ].join('\n');
  }

  it.each([
    [
      'a uuid refusal',
      sql`select ${VALUE}::uuid`,
      `invalid input syntax for type uuid: ${REDACTED}`,
    ],
    ['a regclass refusal', sql`select ${VALUE}::regclass`, `relation ${REDACTED} does not exist`],
    [
      'a jsonb refusal',
      sql`select ${`{"note":"${VALUE}`}::jsonb`,
      'invalid input syntax for type json',
    ],
  ])('seals %s and keeps its reason', async (_, statement, reason) => {
    const err = await caught(() => db.execute(statement));
    expect(err).toBeInstanceOf(DrizzleQueryError);
    expect(everyCopy(err)).not.toContain('zq9');
    expect((err.cause as Error).message).toBe(reason);
    expect(err.message).toMatch(/^Failed query: select \$1::\w+\nparams: \[Redacted\]$/);
  });

  it.each([
    ['to_date', sql`select to_date(${VALUE}, 'YYYY')`],
    ['to_timestamp', sql`select to_timestamp(${VALUE}, 'YYYY')`],
  ])('seals a %s refusal that quotes only the start of its value', async (_, statement) => {
    const err = await caught(() => db.execute(statement));
    expect(everyCopy(err)).not.toContain('zq9');
    expect((err.cause as Error).message).toBe(`invalid value ${REDACTED}`);
  });

  it('seals a unique violation and still reads it as one, inside a transaction', async () => {
    await db.execute(
      sql`create unique index if not exists seal_probe_now on seal_probe (lower(v))`,
    );
    const err = await caught(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`insert into seal_probe (v) values (${VALUE.toUpperCase()})`);
        await tx.execute(sql`insert into seal_probe (v) values (${VALUE})`);
      }),
    );
    expect(everyCopy(err).toLowerCase()).not.toContain('zq9');
    expect(isUniqueViolation(err)).toBe(true);
    expect((err.cause as Record<string, unknown>).constraint_name).toBe('seal_probe_now');
    await db.execute(sql`drop index seal_probe_now`);
  });

  it('seals a deferred unique violation the database rejects only at COMMIT', async () => {
    const err = await caught(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`insert into seal_probe (v) values (${VALUE})`);
        await tx.execute(sql`insert into seal_probe (v) values (${VALUE})`);
      }),
    );
    expect(err).not.toBeInstanceOf(DrizzleQueryError);
    expect((err as unknown as Record<string, unknown>).code).toBe('23505');
    expect((err as unknown as Record<string, unknown>).constraint_name).toBe('seal_probe_v_key');
    expect(`${err.message}\n${err.stack}\n${JSON.stringify(err)}`).not.toContain('zq9');
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('seals a refusal inside a nested transaction', async () => {
    const err = await caught(() =>
      db.transaction(async (tx) => {
        await tx.transaction(async (inner) => {
          await inner.execute(sql`select ${VALUE}::uuid`);
        });
      }),
    );
    expect(everyCopy(err)).not.toContain('zq9');
  });
});
