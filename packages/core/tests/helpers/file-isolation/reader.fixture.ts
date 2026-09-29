import { afterAll, beforeAll, expect, it } from 'vitest';
import { setupTestDatabase, type TestDatabase } from '../db.js';
import { leave, MARKER, waitFor } from './probe.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await setupTestDatabase();
});

afterAll(async () => {
  await t?.cleanup();
});

it('depends on the row the writer file wrote', async () => {
  const [me] = await t.client<{ db: string }[]>`SELECT current_database() AS db`;
  leave('reader-db', me?.db ?? '');
  await waitFor('writer-db');
  const [table] = await t.client<{ t: string | null }[]>`
    SELECT to_regclass('public.isolation_probe')::text AS t
  `;
  const rows = table?.t
    ? await t.client<{ v: string }[]>`SELECT v FROM isolation_probe WHERE v = ${MARKER()}`
    : [];
  expect(rows, 'the row the writer file wrote').toEqual([{ v: MARKER() }]);
});
