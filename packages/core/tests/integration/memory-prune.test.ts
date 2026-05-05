import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// Integration coverage for ISS-27 prune lifecycle: stale-memory deletion,
// knowledge_edges cascade, and edge invalidation. Uses a real Postgres so
// the SQL CTE / RETURNING / `now() - interval` semantics are exercised
// against the actual driver (postgres-js).

const DIM = 1536;
function zeroVec(): number[] {
  return new Array<number>(DIM).fill(0);
}

describe('F3 memory prune integration', () => {
  let harness: TestDatabase;
  let runMemoryPrune: typeof import('../../src/memory/prune.js').runMemoryPrune;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';
    ({ runMemoryPrune } = await import('../../src/memory/prune.js'));
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function insertMemory(opts: {
    projectId: string;
    sourceRef: string;
    retrievalCount: number;
    createdDaysAgo?: number;
    updatedDaysAgo?: number;
  }): Promise<string> {
    const vecLiteral = `[${zeroVec().join(',')}]`;
    const created = opts.createdDaysAgo ?? 0;
    const updated = opts.updatedDaysAgo ?? created;
    const rows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO memories
        (project_id, source, source_ref, text_content, embedding, metadata,
         retrieval_count, created_at, updated_at)
      VALUES
        (${opts.projectId}, 'note', ${opts.sourceRef}, 'm', ${vecLiteral}::vector, '{}'::jsonb,
         ${opts.retrievalCount},
         now() - (${created}::int * interval '1 day'),
         now() - (${updated}::int * interval '1 day'))
      RETURNING id::text AS id
    `);
    const first = (rows as Array<{ id: string }>)[0];
    if (!first) throw new Error('insertMemory failed');
    return first.id;
  }

  async function insertEdge(opts: {
    projectId: string;
    subject: string;
    predicate: string;
    object: string;
    sourceMemoryId?: string;
    createdDaysAgo?: number;
    validUntil?: 'null';
  }): Promise<void> {
    const created = opts.createdDaysAgo ?? 0;
    await harness.db.execute(sql`
      INSERT INTO knowledge_edges
        (project_id, subject, predicate, object, source_memory_id, created_at, valid_until)
      VALUES
        (${opts.projectId}, ${opts.subject}, ${opts.predicate}, ${opts.object},
         ${opts.sourceMemoryId ?? null},
         now() - (${created}::int * interval '1 day'),
         NULL)
    `);
  }

  async function memoryCount(projectId: string): Promise<number> {
    const rows = await harness.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM memories WHERE project_id = ${projectId}`,
    );
    return Number((rows[0] as { count: string }).count);
  }

  async function edgeCount(projectId: string): Promise<number> {
    const rows = await harness.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM knowledge_edges WHERE project_id = ${projectId}`,
    );
    return Number((rows[0] as { count: string }).count);
  }

  it('UC-4 / UC-5: deletes stale (retrieval_count=0 + >30d) but keeps frequently used', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);

    // Fresh memory, retrievalCount=0 — should NOT be pruned.
    await insertMemory({
      projectId: project.id,
      sourceRef: 'fresh',
      retrievalCount: 0,
      createdDaysAgo: 5,
    });
    // Stale memory, retrievalCount=0, 31d old — should be pruned (UC-4).
    await insertMemory({
      projectId: project.id,
      sourceRef: 'stale-zero',
      retrievalCount: 0,
      createdDaysAgo: 31,
    });
    // Old but heavily-used memory — should NOT be pruned (UC-5).
    await insertMemory({
      projectId: project.id,
      sourceRef: 'old-popular',
      retrievalCount: 5,
      createdDaysAgo: 60,
      updatedDaysAgo: 60,
    });

    const result = await runMemoryPrune();
    expect(result.prunedMemories).toBe(1);
    expect(await memoryCount(project.id)).toBe(2);
  });

  it('UC-6: prunes rarely-retrieved memories whose updated_at is >90 days', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);

    // retrievalCount=2 but >90 days since update → pruned.
    await insertMemory({
      projectId: project.id,
      sourceRef: 'rare-old',
      retrievalCount: 2,
      createdDaysAgo: 100,
      updatedDaysAgo: 91,
    });
    // retrievalCount=3 → NOT pruned (the predicate is `< 3`).
    await insertMemory({
      projectId: project.id,
      sourceRef: 'borderline',
      retrievalCount: 3,
      createdDaysAgo: 100,
      updatedDaysAgo: 100,
    });

    const result = await runMemoryPrune();
    expect(result.prunedMemories).toBe(1);
    expect(await memoryCount(project.id)).toBe(1);
  });

  it('cascades knowledge_edges deletion when their source_memory_id is pruned', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);

    const doomed = await insertMemory({
      projectId: project.id,
      sourceRef: 'doomed',
      retrievalCount: 0,
      createdDaysAgo: 31,
    });
    // 2 edges pointing at the doomed memory + 1 edge with no source → only
    // the first 2 cascade.
    await insertEdge({
      projectId: project.id,
      subject: 's1',
      predicate: 'p1',
      object: 'o1',
      sourceMemoryId: doomed,
    });
    await insertEdge({
      projectId: project.id,
      subject: 's2',
      predicate: 'p2',
      object: 'o2',
      sourceMemoryId: doomed,
    });
    await insertEdge({
      projectId: project.id,
      subject: 's3',
      predicate: 'p3',
      object: 'o3',
    });

    const result = await runMemoryPrune();
    expect(result.prunedMemories).toBe(1);
    expect(result.cascadedEdges).toBe(2);
    expect(await edgeCount(project.id)).toBe(1);
  });

  it('UC-8: invalidates open edges older than 60 days', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);

    await insertEdge({
      projectId: project.id,
      subject: 'old',
      predicate: 'p',
      object: 'o',
      createdDaysAgo: 61,
    });
    await insertEdge({
      projectId: project.id,
      subject: 'new',
      predicate: 'p',
      object: 'o',
      createdDaysAgo: 5,
    });

    const result = await runMemoryPrune();
    expect(result.invalidatedEdges).toBe(1);

    const rows = await harness.db.execute<{ subject: string; valid_until: string | null }>(
      sql`SELECT subject, valid_until FROM knowledge_edges WHERE project_id = ${project.id} ORDER BY subject`,
    );
    const byKey = Object.fromEntries(
      (rows as Array<{ subject: string; valid_until: string | null }>).map((r) => [
        r.subject,
        r.valid_until,
      ]),
    );
    expect(byKey.old).not.toBeNull();
    expect(byKey.new).toBeNull();
  });

  it('legacy memories with default role/visibility are unaffected by prune predicates', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);

    // Mimic a row migrated from the pre-ISS-27 schema: defaulted role=dev,
    // visibility=all, retrieval_count=0. Created today, so safe.
    const id = await insertMemory({
      projectId: project.id,
      sourceRef: 'legacy',
      retrievalCount: 0,
      createdDaysAgo: 0,
    });

    await runMemoryPrune();
    const rows = await harness.db.execute<{ role: string; visibility: string }>(
      sql`SELECT role, visibility FROM memories WHERE id = ${id}`,
    );
    const r = (rows[0] ?? null) as { role: string; visibility: string } | null;
    expect(r).not.toBeNull();
    expect(r?.role).toBe('dev');
    expect(r?.visibility).toBe('all');
  });
});
