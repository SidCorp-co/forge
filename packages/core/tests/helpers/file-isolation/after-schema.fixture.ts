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
