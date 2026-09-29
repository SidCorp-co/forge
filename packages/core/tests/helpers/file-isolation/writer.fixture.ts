import { afterAll, beforeAll, it } from 'vitest';
import { setupTestDatabase, type TestDatabase } from '../db.js';
import { leave, MARKER, waitFor } from './probe.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await setupTestDatabase();
});

afterAll(async () => {
  await t?.cleanup();
});

it('writes the row the reader file depends on', async () => {
  // At two workers, wait until the reader is running, so the two files provably overlap.
  if (process.env.ISOLATION_OVERLAP === '1') await waitFor('reader-db');
  await t.client`CREATE TABLE IF NOT EXISTS isolation_probe (v text NOT NULL)`;
  await t.client`INSERT INTO isolation_probe (v) VALUES (${MARKER()})`;
  const [row] = await t.client<{ db: string }[]>`SELECT current_database() AS db`;
  leave('writer-db', row?.db ?? '');
});
