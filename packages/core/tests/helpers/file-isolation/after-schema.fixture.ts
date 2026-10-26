import { afterAll, beforeAll, expect, it } from 'vitest';
import { setupTestDatabase, type TestDatabase } from '../db.js';
import { databaseOf, leave } from './probe.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await setupTestDatabase();
});

afterAll(async () => {
  await t?.cleanup();
});

it('is handed a database without the table a file before it created', async () => {
  leave('after-schema-db', await databaseOf(t.client));
  const [table] = await t.client<{ t: string | null }[]>`
    SELECT to_regclass('public.isolation_probe')::text AS t
  `;
  expect(table?.t, 'the table the earlier file created').toBeNull();
});

it('is handed the sequence as the template defines it', async () => {
  const [seq] = await t.client<{ step: string }[]>`
    SELECT increment_by::text AS step FROM pg_sequences
    WHERE schemaname = 'drizzle' AND sequencename = '__drizzle_migrations_id_seq'
  `;
  expect(seq?.step, 'the sequence step').toBe('1');
});

it('keeps a row it inserts, with no rule a file before it left on the table', async () => {
  await t.client`INSERT INTO admin_thresholds (stuck_job_seconds) VALUES (4242)`;
  const rows = await t.client`SELECT 1 FROM admin_thresholds WHERE stuck_job_seconds = 4242`;
  expect(rows.length, 'the row this file just inserted').toBe(1);
});
