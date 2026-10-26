import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDatabase, type TestDatabase } from '../helpers/db.js';
import { readSchemaOn, schemaChangesOn } from '../helpers/slot-db.js';

// A slot database goes from file to file, and what keeps one file's schema from the next is the
// read its teardown compares (`tests/helpers/slot-db.ts:schemaChangesOn`): a hash over every catalog
// row, and the objects named once the hash moved. Each case below makes one kind of change a file
// could leave behind, reads it inside the same transaction and rolls back, so every case starts from
// the clone. A kind the read missed would pass a file that left it, and hand the next file in that
// slot a schema the template does not have.

let t: TestDatabase;
let clone: { hash: string; objects?: Record<string, string> };

beforeAll(async () => {
  t = await setupTestDatabase({ own: 'changes the schema in transactions it rolls back' });
  clone = await readSchemaOn(t.client, true);
});

afterAll(async () => {
  await t?.cleanup();
});

const ROLLBACK = new Error('rolled back on purpose');

/** What the digest says changed once `statements` ran, read before they are rolled back. */
async function driftAfter(statements: string[]): Promise<string[]> {
  let drift: string[] = [];
  await t.client
    .begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
      drift = await schemaChangesOn(tx, clone.hash, () => clone.objects ?? {});
      throw ROLLBACK;
    })
    .catch((err) => {
      if (err !== ROLLBACK) throw err;
    });
  return drift;
}

describe('the slot digest names every kind of schema change a file can leave behind', () => {
  it.each([
    {
      kind: 'a rule on a table',
      statements: ['CREATE RULE plant_swallow AS ON INSERT TO admin_thresholds DO INSTEAD NOTHING'],
      names: 'added rule plant_swallow on table admin_thresholds',
    },
    {
      kind: 'an aggregate',
      statements: ['CREATE AGGREGATE plant_sum(integer) (SFUNC = int4pl, STYPE = integer)'],
      names: 'added aggregate function plant_sum(integer)',
    },
    {
      kind: 'forced row level security',
      statements: ['ALTER TABLE admin_thresholds FORCE ROW LEVEL SECURITY'],
      names: 'changed table admin_thresholds',
    },
    {
      kind: 'a column collation',
      statements: ['ALTER TABLE projects ALTER COLUMN name TYPE text COLLATE "C"'],
      names: 'changed columns of table projects',
    },
    {
      kind: 'a column statistics target',
      statements: ['ALTER TABLE projects ALTER COLUMN name SET STATISTICS 500'],
      names: 'changed columns of table projects',
    },
    {
      kind: 'an unlogged table',
      statements: ['ALTER TABLE admin_thresholds SET UNLOGGED'],
      names: 'changed table admin_thresholds',
    },
    {
      kind: 'a replica identity',
      statements: ['ALTER TABLE admin_thresholds REPLICA IDENTITY FULL'],
      names: 'changed table admin_thresholds',
    },
    {
      kind: 'a statistics object',
      statements: ['CREATE STATISTICS plant_stats ON id, name FROM projects'],
      names: 'added statistics object plant_stats',
    },
    {
      kind: 'a comment',
      statements: ["COMMENT ON TABLE admin_thresholds IS 'planted'"],
      names: 'added comment on table admin_thresholds',
    },
    {
      kind: 'a collation',
      statements: ['CREATE COLLATION plant_collation FROM "C"'],
      names: 'added collation plant_collation',
    },
    {
      kind: 'a storage option',
      statements: ['ALTER TABLE admin_thresholds SET (fillfactor = 50)'],
      names: 'changed table admin_thresholds',
    },
    {
      kind: 'a grant',
      statements: ['GRANT SELECT ON admin_thresholds TO PUBLIC'],
      names: 'changed table admin_thresholds',
    },
    {
      kind: 'a publication',
      statements: ['CREATE PUBLICATION plant_publication FOR TABLE admin_thresholds'],
      names: 'added publication plant_publication',
    },
    {
      kind: 'a database setting',
      statements: [
        "DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET work_mem = %L', current_database(), '8MB'); END $$",
      ],
      names: "changed this database's grants and settings",
    },
    {
      kind: 'an enum',
      statements: ["CREATE TYPE plant_mood AS ENUM ('calm', 'stormy')"],
      names: 'added labels of type plant_mood',
    },
    {
      kind: 'a table',
      statements: ['CREATE TABLE plant_table (v text)'],
      names: 'added table plant_table',
    },
  ])('names $kind', async ({ statements, names }) => {
    expect(await driftAfter(statements)).toContain(names);
  });

  it('names nothing for what a file does by using the schema: rows, statistics, truncation, sequences', async () => {
    const drift = await driftAfter([
      'INSERT INTO admin_thresholds DEFAULT VALUES',
      'ANALYZE admin_thresholds',
      'TRUNCATE admin_thresholds RESTART IDENTITY CASCADE',
      "SELECT setval('drizzle.__drizzle_migrations_id_seq', 9999)",
      'SELECT lo_create(0)',
    ]);
    expect(drift).toEqual([]);
  });
});
