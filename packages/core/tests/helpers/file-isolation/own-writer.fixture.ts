import { afterAll, beforeAll, it } from 'vitest';
import { setupTestDatabase, type TestDatabase } from '../db.js';
import { databaseOf, leave } from './probe.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await setupTestDatabase({ own: 'creates a table, to show a declared file may' });
});

afterAll(async () => {
  await t?.cleanup();
});

it('creates a table in the database it declared', async () => {
  await t.client`CREATE TABLE isolation_probe (v text NOT NULL)`;
  leave('own-writer-db', await databaseOf(t.client));
});
