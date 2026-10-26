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
  await t.client`ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq INCREMENT BY 7`;
  // No table and no column: a rule a later file's insert would vanish into.
  await t.client`CREATE RULE isolation_swallow AS ON INSERT TO admin_thresholds DO INSTEAD NOTHING`;
  leave('schema-writer-db', await databaseOf(t.client));
});
