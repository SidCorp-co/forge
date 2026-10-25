import { afterAll, beforeAll, it } from 'vitest';
import { setupTestDatabase, type TestDatabase } from '../db.js';
import { databaseOf, leave } from './probe.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await setupTestDatabase();
});

// Refused here: the table below is schema the next file in this slot would inherit.
afterAll(async () => {
  await t?.cleanup();
});

it('creates a table in its shared slot database without declaring it', async () => {
  await t.client`CREATE TABLE isolation_probe (v text NOT NULL)`;
  leave('schema-writer-db', await databaseOf(t.client));
});
