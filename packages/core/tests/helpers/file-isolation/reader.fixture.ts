import { afterAll, beforeAll, expect, it } from 'vitest';
import { setupTestDatabase, type TestDatabase } from '../db.js';
import { databaseOf, leave, MARKER, waitFor } from './probe.js';

let t: TestDatabase;
let writerSeq: string;

beforeAll(async () => {
  t = await setupTestDatabase();
  leave('reader-db', await databaseOf(t.client));
  await waitFor('writer-db');
  writerSeq = await waitFor('writer-seq');
});

afterAll(async () => {
  await t?.cleanup();
});

it('depends on the row the writer file wrote', async () => {
  const rows = await t.client<{ v: number }[]>`
    SELECT stuck_job_seconds AS v FROM admin_thresholds WHERE stuck_job_seconds = ${MARKER()}
  `;
  expect(rows, 'the row the writer file wrote').toEqual([{ v: MARKER() }]);
});

it('finds the template seed row the writer file deleted', async () => {
  const [row] = await t.client<{ n: number }[]>`
    SELECT count(*)::int AS n FROM rocketchat_comment_mirror_state
  `;
  expect(row?.n, 'the seed row').toBe(1);
});

it('reads the sequence the writer file advanced at the value the writer found', async () => {
  const [seq] = await t.client<{ v: string }[]>`
    SELECT last_value::text AS v FROM drizzle.__drizzle_migrations_id_seq
  `;
  expect(seq?.v, 'the sequence').toBe(writerSeq);
});

it('finds no queue schema the writer file started', async () => {
  const [table] = await t.client<{ t: string | null }[]>`
    SELECT to_regclass('pgboss.schedule')::text AS t
  `;
  expect(table?.t, 'the queue table').toBeNull();
});
