import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const DIM = 1536;
function hotVector(hotIdx: number, mag = 1): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[hotIdx] = mag;
  return v;
}
const vec = (v: number[]) => `[${v.join(',')}]`;

let harness: TestDatabase;
let projectId: string;
let chunkedProjectId: string;
let userId: string;
let app: Hono<{ Variables: RequestIdVars }>;
let token: string;
let search: typeof import('../../src/memory/search.js');
let knowledge: typeof import('../../src/knowledge/search.js');
let listService: typeof import('../../src/issues/list-service.js');

async function seed(): Promise<void> {
  const memory = async (pid: string, text: string, hot: number, extra = '') =>
    harness.db.execute(sql`
      INSERT INTO memories (project_id, source, source_ref, text_content, embedding, metadata ${sql.raw(extra ? ', chunk_generation, chunked_at' : '')})
      VALUES (${pid}::uuid, 'note', ${randomUUID()}, ${text}, ${vec(hotVector(hot))}::vector, '{}'::jsonb ${sql.raw(extra)})
      RETURNING id`);
  await memory(projectId, 'Set LITELLM_API_URL to the proxy host before the fast model starts.', 1);
  await memory(
    projectId,
    'The close cascade lives in packages/core/src/pipeline/runs-cascade.ts and runs on every terminal flip.',
    2,
  );
  await memory(
    projectId,
    'The reranker in packages/core/src/memory/rerank.ts hashes the shown text into its cache key.',
    3,
  );
  await memory(projectId, 'A deploy rolls back when the health check fails twice in a row.', 4);
  await memory(projectId, 'Counting apples: iss 12 and 26 apples were sorted apart.', 5);
  await memory(projectId, 'applyKernelTransition is the only writer of pipeline_runs.status.', 6);
  const parent = (await memory(
    chunkedProjectId,
    'Parent row head with nothing searchable in it.',
    1,
    ', 1, now()',
  )) as unknown as { id: string }[];
  const parentId = parent[0]?.id;
  if (!parentId) throw new Error('parent memory was not inserted');
  await harness.db.execute(sql`
    INSERT INTO memory_chunks (memory_id, chunk_index, text_content, context_prefix, embedding, generation)
    VALUES (${parentId}::uuid, 0, 'Deep in passage two: LITELLM_API_URL names the proxy, never a vendor.', 'note', ${vec(hotVector(1))}::vector, 1)`);
  await harness.db.execute(sql`
    INSERT INTO knowledge_entries (project_id, kind, slug, title, body, embedding)
    VALUES (${projectId}::uuid, 'convention', 'proxy-url', 'Proxy configuration', 'Both readers build the URL from LITELLM_API_URL through lib/openai-compat-url.ts.', ${vec(hotVector(1))}::vector)`);
  await harness.db.execute(sql`
    INSERT INTO issues (project_id, created_by_id, iss_seq, title, description) VALUES
    (${projectId}::uuid, ${userId}::uuid, 1, 'Orphan jobs under a terminal run', 'The fix routes every flip through packages/core/src/pipeline/runs-cascade.ts.'),
    (${projectId}::uuid, ${userId}::uuid, 2, 'Health check flakes on cold start', 'Unrelated body about the health probe timing.')`);
}

describe('identifier-aware keyword search (ISS-907)', () => {
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
    process.env.EMBEDDINGS_BASE_URL ??= 'https://stub.invalid';
    process.env.EMBEDDINGS_API_KEY ??= 'stub-key';
    search = await import('../../src/memory/search.js');
    knowledge = await import('../../src/knowledge/search.js');
    listService = await import('../../src/issues/list-service.js');
    const { searchRoutes } = await import('../../src/issues/search.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const { signUserToken } = await import('../../src/auth/jwt.js');
    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/projects', searchRoutes);
    app.onError(errorHandler);

    await truncateAll(harness.db);
    const user = await createTestUser(harness.db);
    userId = user.id;
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${userId}::uuid`,
    );
    const project = await createTestProject(harness.db, userId);
    projectId = project.id;
    await createTestProjectMember(harness.db, { userId, projectId, role: 'admin' });
    const chunked = await createTestProject(harness.db, userId, {
      slug: `chunked-${randomUUID().slice(0, 8)}`,
    });
    chunkedProjectId = chunked.id;
    token = await signUserToken(userId);

    await seed();
  }, 120_000);

  afterAll(async () => {
    await harness.cleanup();
  });

  it('forge_identifier_words is one immutable function that splits the three identifier shapes', async () => {
    const rows = (await harness.db.execute(sql`
      SELECT forge_identifier_words('LITELLM_API_URL') AS a, forge_identifier_words('runs-cascade.ts') AS b,
             forge_identifier_words('applyKernelTransition') AS c,
             (SELECT provolatile FROM pg_proc WHERE proname = 'forge_identifier_words') AS vol`)) as unknown as {
      a: string;
      b: string;
      c: string;
      vol: string;
    }[];
    expect(rows[0]).toMatchObject({
      a: 'litellm api url',
      b: 'runs cascade ts',
      c: 'apply kernel transition',
      vol: 'i',
    });
  });

  it('the four tables carry a generated ident_search column with a GIN index', async () => {
    const cols = (await harness.db.execute(sql`
      SELECT table_name FROM information_schema.columns
      WHERE column_name = 'ident_search' AND is_generated = 'ALWAYS' ORDER BY table_name`)) as unknown as {
      table_name: string;
    }[];
    expect(cols.map((c) => c.table_name)).toEqual([
      'issues',
      'knowledge_entries',
      'memories',
      'memory_chunks',
    ]);
    const idx = (await harness.db.execute(sql`
      SELECT tablename FROM pg_indexes WHERE indexname LIKE '%_ident_search_idx' AND indexdef LIKE '%USING gin%' ORDER BY tablename`)) as unknown as {
      tablename: string;
    }[];
    expect(idx.map((i) => i.tablename)).toEqual([
      'issues',
      'knowledge_entries',
      'memories',
      'memory_chunks',
    ]);
  });

  it('the memory keyword strategy alone finds identifiers by their parts on a flat project', async () => {
    const texts = async (q: string) =>
      (await search.keywordSearchMemories({ projectId, query: q, topK: 8 })).map((h) => h.text);
    expect(await texts('LITELLM_API')).toEqual([expect.stringContaining('LITELLM_API_URL')]);
    expect(await texts('cascade')).toEqual([expect.stringContaining('runs-cascade.ts')]);
    expect(await texts('memory/rerank.ts')).toEqual([
      expect.stringContaining('packages/core/src/memory/rerank.ts'),
    ]);
    expect(await texts('transition')).toEqual([expect.stringContaining('applyKernelTransition')]);
    expect(await texts('health check fails')).toEqual([
      expect.stringContaining('health check fails twice'),
    ]);
    expect(await texts('ISS-26')).toEqual([]);
  });

  it('and on a chunked project, through the passage that carries the identifier', async () => {
    const hits = await search.keywordSearchMemories({
      projectId: chunkedProjectId,
      query: 'LITELLM_API',
      topK: 8,
      memoryModel: 'chunked',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.matchedChunk?.text).toContain('LITELLM_API_URL');
  });

  it('the knowledge keyword search finds an entry by an identifier part', async () => {
    const hits = await knowledge.keywordSearchKnowledge(projectId, 'LITELLM_API', 8);
    expect(hits.map((h) => h.slug)).toEqual(['proxy-url']);
  });

  it('the issue list filter and the search route find an issue by an identifier in its description', async () => {
    const rows = await listService.listIssueRows(projectId, { search: 'cascade' }, 50);
    expect(rows.map((r) => r.title)).toEqual(['Orphan jobs under a terminal run']);
    const res = await app.request(`/api/projects/${projectId}/issues/search?q=cascade`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items?: { title: string }[]; data?: { title: string }[] };
    const titles = (body.items ?? body.data ?? []).map((i) => i.title);
    expect(titles).toEqual(['Orphan jobs under a terminal run']);
    const half = await listService.listIssueRows(projectId, { search: 'flak' }, 50);
    expect(half.map((r) => r.title)).toEqual(['Health check flakes on cold start']);
  });

  it('hybrid keeps a hit only the keyword arm found inside the top 8', async () => {
    for (let i = 0; i < 8; i++) {
      await harness.db.execute(sql`
        INSERT INTO memories (project_id, source, source_ref, text_content, embedding, metadata)
        VALUES (${projectId}::uuid, 'note', ${randomUUID()}, ${`Decoy number ${i} about pears and plums.`}, ${vec(hotVector(9, 1 - i / 100))}::vector, '{}'::jsonb)`);
    }
    const { hits, breakdown } = await search.hybridSearchMemories({
      projectId,
      queryVec: hotVector(9),
      query: 'LITELLM_API',
      topK: 8,
    });
    expect(breakdown.semanticHits).toBe(8);
    expect(breakdown.keywordHits).toBe(1);
    expect(breakdown.overlap).toBe(0);
    expect(hits.map((h) => h.text)).toContainEqual(expect.stringContaining('LITELLM_API_URL'));
  });
});
