import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('runMemoryDecay counts the rows it moved', () => {
  let harness: TestDatabase;
  let projectId: string;
  let runMemoryDecay: typeof import('../../src/memory/decay.js').runMemoryDecay;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-pepper-at-least-32-chars-long-abcdef-12';
    ({ runMemoryDecay } = await import('../../src/memory/decay.js'));
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    projectId = project.id;
  });

  /** One `note` memory, placed in time by how long ago it was created and last updated. */
  async function seedMemory(args: {
    ref: string;
    createdDaysAgo: number;
    retrievalCount: number;
    archivedDaysAgo?: number;
  }): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO memories (project_id, source, source_ref, text_content, retrieval_count, created_at, updated_at, archived_at)
      VALUES (
        ${projectId}, 'note', ${args.ref}, ${`body ${args.ref}`}, ${args.retrievalCount},
        now() - (${args.createdDaysAgo} || ' days')::interval,
        now() - (${args.createdDaysAgo} || ' days')::interval,
        ${args.archivedDaysAgo === undefined ? null : sql`now() - (${args.archivedDaysAgo} || ' days')::interval`}
      )
    `);
  }

  async function count(where: ReturnType<typeof sql>): Promise<number> {
    const rows = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM memories WHERE project_id = ${projectId} AND ${where}`,
    );
    return rows[0]?.n ?? 0;
  }

  it('reports the number of rows each statement actually moved', async () => {
    // Three archivable: never retrieved and older than the 30-day threshold.
    await seedMemory({ ref: 'stale-1', createdDaysAgo: 40, retrievalCount: 0 });
    await seedMemory({ ref: 'stale-2', createdDaysAgo: 60, retrievalCount: 0 });
    await seedMemory({ ref: 'stale-3', createdDaysAgo: 31, retrievalCount: 0 });
    // Two purgeable: already archived, past the 90-day archive grace.
    await seedMemory({
      ref: 'old-1',
      createdDaysAgo: 400,
      retrievalCount: 0,
      archivedDaysAgo: 120,
    });
    await seedMemory({
      ref: 'old-2',
      createdDaysAgo: 400,
      retrievalCount: 0,
      archivedDaysAgo: 200,
    });
    // Two the pass must leave alone: one young, one archived inside the grace.
    await seedMemory({ ref: 'fresh', createdDaysAgo: 2, retrievalCount: 0 });
    await seedMemory({
      ref: 'recent-archive',
      createdDaysAgo: 400,
      retrievalCount: 0,
      archivedDaysAgo: 5,
    });

    const before = await count(sql`true`);
    const result = await runMemoryDecay();
    const after = await count(sql`true`);

    // The counts are compared with the rows, not with each other: `archived` against how many rows
    // now carry `archived_at` and did not before, `purged` against how many rows left the table.
    // A subject reading a property that happened to hold some other number passes the mocked
    // sibling and fails here.
    expect({
      archived: result.archived,
      purged: result.purged,
      rowsGone: before - after,
      rowsNowArchived: await count(sql`archived_at IS NOT NULL`),
    }).toEqual({
      archived: 3,
      purged: 2,
      rowsGone: 2,
      rowsNowArchived: 4,
    });
  });

  it('reports zero rather than a row count when nothing is eligible', async () => {
    // The boundary: `.count` on a statement that matched nothing must be 0 and not the table's
    // size, which is what a subject falling back to a length over an unbounded read would give.
    await seedMemory({ ref: 'fresh-1', createdDaysAgo: 1, retrievalCount: 0 });
    await seedMemory({ ref: 'fresh-2', createdDaysAgo: 2, retrievalCount: 0 });

    const result = await runMemoryDecay();

    expect({
      archived: result.archived,
      purged: result.purged,
      stillThere: await count(sql`true`),
    }).toEqual({
      archived: 0,
      purged: 0,
      stillThere: 2,
    });
  });
});
