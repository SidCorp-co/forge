/**
 * ISS-1021 — the outbox claim's `attempts` bound lives TWICE: once as
 * `MAX_REDELIVERIES` in `pipeline/outbox-worker.ts`, rendered into the claim as a literal, and
 * once inside migration 0281's predicate on `idx_outbox_unprocessed`. Nothing generates one from
 * the other, so nothing but this test can see them disagree.
 *
 * It runs against a real Postgres and reads the EFFECTIVE index definition out of `pg_indexes`
 * rather than the migration file, because the file is not the authority: a later migration that
 * recreates this index changes what the database holds while leaving 0281 on disk saying otherwise.
 *
 * Disagreement is silent in production, which is why it is worth a test at all. A bound the index
 * does not carry does not fail a query — Postgres just cannot prove the partial predicate is
 * implied, drops back to a sequential scan of the whole table, and keeps returning the right rows
 * (ISS-1021 measured 0.072 ms against 6.69 ms on a seeded 35,001-row table). A bound the index
 * carries but the claim does not is worse: the index would then exclude rows the claim wants, and
 * a transition would sit undelivered.
 */

import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDatabase, type TestDatabase } from '../helpers/index.js';

/** Only the four fields this file asserts on; `EXPLAIN (FORMAT JSON)` returns many more. */
type PlanRoot = {
  Plan?: {
    'Node Type'?: string;
    'Index Name'?: string;
    'Actual Rows'?: number;
    'Heap Fetches'?: number;
  };
};

describe('idx_outbox_unprocessed agrees with the outbox claim', () => {
  let harness: TestDatabase;
  let maxRedeliveries: number;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-pepper-at-least-32-chars-long-abcdef-12';
    const worker = await import('../../src/pipeline/outbox-worker.js');
    maxRedeliveries = worker.MAX_REDELIVERIES;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  async function indexDefinition(): Promise<string> {
    const rows = await harness.db.execute<{ indexdef: string }>(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_outbox_unprocessed'`,
    );
    return rows[0]?.indexdef ?? '';
  }

  it('carries an attempts bound at all', async () => {
    // Asserted on its own so the case below cannot pass by comparing two absences: before 0281
    // this predicate was `WHERE processed_at IS NULL` and the match below would find nothing to
    // disagree with.
    expect(await indexDefinition()).toMatch(/attempts\s*<\s*\d+/);
  });

  it('carries the same attempts bound the claim renders', async () => {
    const def = await indexDefinition();
    const bound = def.match(/attempts\s*<\s*(\d+)/)?.[1];
    expect({ indexBound: Number(bound), claimBound: maxRedeliveries }).toEqual({
      indexBound: maxRedeliveries,
      claimBound: maxRedeliveries,
    });
  });

  it('keeps a dead-lettered row out of the index the claim reads', async () => {
    // The behaviour the bound exists for, asserted rather than inferred from the predicate text.
    //
    // It is asserted on the PLAN, and specifically on an Index Only Scan with zero heap fetches,
    // because counting the query's answer proves nothing here: `processed_at IS NULL AND attempts
    // < 3` returns one row under either predicate — under 0070's the index yields both rows and
    // the heap filter removes the dead-lettered one. Measured: this case passed unchanged when
    // 0070's predicate was planted back. An index-only scan cannot do that. It can only answer
    // from what the index HOLDS, so `Actual Rows: 1` with `Heap Fetches: 0` is the statement that
    // the dead-lettered row is not in there — and under 0070's predicate `attempts` is not in the
    // index at all, so the plan cannot be index-only and the node type alone goes red.
    const insertedId = async (statement: SQL): Promise<string> => {
      const rows = await harness.db.execute<{ id: string }>(statement);
      const id = rows[0]?.id;
      // A missing id here means the INSERT did not return one, which would make every assertion
      // below run against a row that is not there. Refuse rather than carry an undefined onward.
      if (!id) throw new Error('seed INSERT returned no id');
      return id;
    };

    const userId = await insertedId(
      sql`INSERT INTO users (email) VALUES ('outbox-index@example.test') RETURNING id`,
    );
    const orgId = await insertedId(
      sql`INSERT INTO organizations (name, slug, created_by) VALUES ('Outbox Org', 'outbox-org', ${userId}) RETURNING id`,
    );
    const projectId = await insertedId(
      sql`INSERT INTO projects (org_id, slug, name, created_by) VALUES (${orgId}, 'outbox-proj', 'Outbox Project', ${userId}) RETURNING id`,
    );
    const issueId = await insertedId(
      sql`INSERT INTO issues (project_id, title, created_by_id) VALUES (${projectId}, 'Outbox issue', ${userId}) RETURNING id`,
    );

    await harness.db.execute(sql`
      INSERT INTO pipeline_outbox (issue_id, project_id, from_status, to_status, processed_at, attempts)
      VALUES (${issueId}, ${projectId}, 'open', 'in_progress', NULL, ${maxRedeliveries}),
             (${issueId}, ${projectId}, 'open', 'in_progress', NULL, 0)
    `);

    const inTable = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pipeline_outbox WHERE processed_at IS NULL`,
    );

    // ANALYZE so the planner costs against real statistics rather than the defaults for an
    // empty table.
    //
    // `Heap Fetches` is deliberately NOT asserted. It counts the rows an index-only scan could
    // not answer from the visibility map, which only VACUUM sets and only up to the oldest
    // snapshot still open in the cluster. Run alone this file gets 0; run inside the full
    // integration suite, where sibling workers hold concurrent transactions in the same cluster,
    // VACUUM's horizon cannot advance and the same correct plan reports 1. That number is a fact
    // about the vacuum horizon, not about this index, and asserting it made the suite fail on a
    // green subject (measured 2026-09-18, full suite, 1 failed of 2537).
    await harness.db.execute(sql`VACUUM (ANALYZE) pipeline_outbox`);
    await harness.db.execute(sql`SET enable_seqscan = off`);
    const [plan] = await harness.db.execute<{ 'QUERY PLAN': PlanRoot[] }>(
      sql`EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF, COSTS OFF)
          SELECT created_at FROM pipeline_outbox
           WHERE processed_at IS NULL AND attempts < ${sql.raw(String(maxRedeliveries))}`,
    );
    await harness.db.execute(sql`RESET enable_seqscan`);

    const node = plan?.['QUERY PLAN']?.[0]?.Plan;
    expect({
      unprocessedRowsInTable: inTable[0]?.n,
      node: node?.['Node Type'],
      index: node?.['Index Name'],
      rowsTheIndexHolds: node?.['Actual Rows'],
    }).toEqual({
      // Two rows are unprocessed and only ONE is in the index: the dead-lettered row, at
      // `attempts = MAX_REDELIVERIES`, is absent from it. That gap between 2 and 1 IS the
      // criterion, and it is what the old `attempts`-less predicate cannot produce — planted,
      // that index holds both rows and this reads 2, on an `Index Scan` rather than an
      // index-only one.
      unprocessedRowsInTable: 2,
      node: 'Index Only Scan',
      index: 'idx_outbox_unprocessed',
      rowsTheIndexHolds: 1,
    });
  });
});
