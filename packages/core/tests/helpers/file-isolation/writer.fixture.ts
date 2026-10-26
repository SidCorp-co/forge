import { afterAll, beforeAll, it } from 'vitest';
import { setupTestDatabase, type TestDatabase } from '../db.js';
import { databaseOf, leave, MARKER, waitFor } from './probe.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await setupTestDatabase();
});

afterAll(async () => {
  await t?.cleanup();
});

it('plants a row and a queue schema, deletes the template seed row and advances a sequence', async () => {
  // At two workers, wait until the reader is running, so the two files provably overlap.
  if (process.env.ISOLATION_OVERLAP === '1') await waitFor('reader-db');
  const [seq] = await t.client<{ v: string }[]>`
    SELECT last_value::text AS v FROM drizzle.__drizzle_migrations_id_seq
  `;
  leave('writer-seq', seq?.v ?? '');
  await t.client`SELECT nextval('drizzle.__drizzle_migrations_id_seq')`;
  await t.client`DELETE FROM rocketchat_comment_mirror_state`;
  await t.client`INSERT INTO admin_thresholds (stuck_job_seconds) VALUES (${MARKER()})`;
  // What starting the queue leaves: a schema of pg-boss's own, which no migration makes.
  await t.client`CREATE SCHEMA pgboss`;
  await t.client`CREATE TABLE pgboss.schedule (name text PRIMARY KEY)`;
  leave('writer-db', await databaseOf(t.client));
});
