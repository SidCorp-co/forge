import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDatabase, type TestDatabase } from '../helpers/db.js';
import { readSchemaOn, schemaChangesOn } from '../helpers/slot-digest.js';

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
      kind: 'a TOAST storage option',
      statements: ['ALTER TABLE projects SET (toast.autovacuum_enabled = false)'],
      names: 'added toast options of table projects',
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

  it('names both tables when two swap their TOAST storage options', async () => {
    let drift: string[] = [];
    await t.client
      .begin(async (tx) => {
        await tx.unsafe('ALTER TABLE projects SET (toast.autovacuum_enabled = false)');
        await tx.unsafe('ALTER TABLE labels SET (toast.autovacuum_enabled = true)');
        const set = await readSchemaOn(tx, true);
        await tx.unsafe('ALTER TABLE projects SET (toast.autovacuum_enabled = true)');
        await tx.unsafe('ALTER TABLE labels SET (toast.autovacuum_enabled = false)');
        drift = await schemaChangesOn(tx, set.hash, () => set.objects ?? {});
        throw ROLLBACK;
      })
      .catch((err) => {
        if (err !== ROLLBACK) throw err;
      });
    expect(drift).toEqual([
      'changed toast options of table labels',
      'changed toast options of table projects',
    ]);
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

  // A rewrite folds a column's missing value into the rows and clears `atthasmissing` (ISS-1315 r3).
  const missing = (table: string) =>
    t.client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid = ${table}::regclass AND atthasmissing
    `.then(([row]) => row?.n ?? 0);

  it('names nothing for VACUUM FULL, which rewrites a table without changing its schema', async () => {
    expect(
      await missing('projects'),
      'the template gave projects no missing value',
    ).toBeGreaterThan(0);
    await t.client.unsafe('VACUUM FULL projects');
    expect(await missing('projects')).toBe(0);
    expect(await schemaChangesOn(t.client, clone.hash, () => clone.objects ?? {})).toEqual([]);
    expect(await driftAfter(['ALTER TABLE projects ALTER COLUMN name SET STATISTICS 500'])).toEqual(
      ['changed columns of table projects'],
    );
  });

  it('names nothing for VACUUM FULL of a table whose dropped columns left it a TOAST table no live column needs', async () => {
    const storage = () =>
      t.client<{ dropped: number; toast: boolean }[]>`
        SELECT (SELECT count(*)::int FROM pg_attribute WHERE attrelid = c.oid AND attisdropped) AS dropped,
          c.reltoastrelid <> 0 AS toast
        FROM pg_class c WHERE c.oid = 'project_git_credentials'::regclass
      `.then(([row]) => row);
    const cloned = await storage();
    expect(cloned?.dropped, 'the template dropped no column of the table').toBeGreaterThan(0);
    expect(cloned?.toast, 'the template gave the table no TOAST table').toBe(true);
    await t.client.unsafe('VACUUM FULL project_git_credentials');
    expect((await storage())?.toast, 'the rewrite kept the TOAST table').toBe(false);
    expect(await schemaChangesOn(t.client, clone.hash, () => clone.objects ?? {})).toEqual([]);
    expect(
      await driftAfter(['ALTER TABLE project_git_credentials ADD COLUMN plant_note text']),
    ).toContain('changed columns of table project_git_credentials');
  });

  it('names nothing for a whole-database VACUUM FULL', async () => {
    const whole = await setupTestDatabase({ own: 'rewrites every table with VACUUM FULL' });
    try {
      const before = await readSchemaOn(whole.client, true);
      await whole.client.unsafe('VACUUM FULL');
      expect(await schemaChangesOn(whole.client, before.hash, () => before.objects ?? {})).toEqual(
        [],
      );
    } finally {
      await whole.cleanup();
    }
  });

  // A column altered to the type it has rebuilds every index and constraint on it, and every foreign
  // key that references it, under new oids; `pg_dump -s` prints the same schema (ISS-1315 r6).
  it('names nothing for a column altered to the type it already has', async () => {
    expect(await driftAfter(['ALTER TABLE projects ALTER COLUMN id TYPE uuid USING id'])).toEqual(
      [],
    );
  });

  it('still names a column altered to another type', async () => {
    expect(
      await driftAfter(['ALTER TABLE admin_thresholds ALTER COLUMN stuck_job_seconds TYPE bigint']),
    ).toContain('changed columns of table admin_thresholds');
  });

  it('names only the index CLUSTER marks, and none of the columns its rewrite touched', async () => {
    expect(await missing('labels'), 'the template gave labels no missing value').toBeGreaterThan(0);
    expect(await driftAfter(['CLUSTER labels USING labels_pkey'])).toEqual([
      'changed index labels_pkey',
    ]);
  });
});
