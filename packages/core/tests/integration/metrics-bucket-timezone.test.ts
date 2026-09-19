import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { utcDateTrunc, utcDayText } from '../../src/lib/time-buckets.js';
import { setupTestDatabase, type TestDatabase } from '../helpers/index.js';

let harness: TestDatabase;

const INSTANT = '2026-09-06T20:51:00.000Z';

const ZONES = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Asia/Ho_Chi_Minh'];

beforeAll(async () => {
  harness = await setupTestDatabase();
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

async function underZone(zone: string, expr: ReturnType<typeof utcDateTrunc>): Promise<string> {
  return await harness.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL TIME ZONE ${sql.raw(`'${zone}'`)}`);
    const rows = (await tx.execute(
      sql`SELECT ${expr} AS bucket FROM (SELECT ${INSTANT}::timestamptz AS ts) s`,
    )) as unknown as Array<{ bucket: unknown }>;
    const bucket = rows[0]?.bucket;
    return bucket instanceof Date ? bucket.toISOString() : new Date(bucket as string).toISOString();
  });
}

it.each(ZONES)('day buckets to UTC midnight under session zone %s', async (zone) => {
  expect(await underZone(zone, utcDateTrunc('day', sql`s.ts`))).toBe('2026-09-06T00:00:00.000Z');
});

it.each(ZONES)('hour buckets to the UTC hour under session zone %s', async (zone) => {
  expect(await underZone(zone, utcDateTrunc('hour', sql`s.ts`))).toBe('2026-09-06T20:00:00.000Z');
});

it.each(ZONES)('day labels read as the UTC calendar day under session zone %s', async (zone) => {
  const rows = (await harness.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL TIME ZONE ${sql.raw(`'${zone}'`)}`);
    return await tx.execute(
      sql`SELECT ${utcDayText(sql`s.ts`)} AS date FROM (SELECT ${INSTANT}::timestamptz AS ts) s`,
    );
  })) as unknown as Array<{ date: string }>;
  expect(rows[0]?.date).toBe('2026-09-06');
});
