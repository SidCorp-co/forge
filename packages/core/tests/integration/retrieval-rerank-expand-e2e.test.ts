// Retrieval v3 phases 1+3 (ISS-905) against a real Postgres: the project's
// rerank flag turns an agent's hybrid search into the fast model's order (with
// the RRF order kept on a prose answer, on the web surface and in the holdout),
// and the expansion flag appends an issue hit's one-hop neighbours marked `via`.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const holdout = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/memory/rerank.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/memory/rerank.js')>();
  return { ...actual, inRerankHoldout: () => holdout.on };
});

type RequestIdVars = import('../../src/middleware/request-id.js').RequestIdVars;
type SearchService = typeof import('../../src/memory/search-service.js');

const DIM = 1536;
function vec(hot: number[]): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const i of hot) v[i] = 1;
  return v;
}

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let runMemorySearch: SearchService['runMemorySearch'];
let resetRerankCache: () => void;
let rerankMod: typeof import('../../src/memory/rerank.js');
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let embeddingsMod: typeof import('../../src/embeddings/index.js');
const modelReplies: string[] = [];
const modelRequests: Array<Record<string, unknown>> = [];

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
  process.env.LITELLM_API_URL = 'https://fast-model.stub.invalid';
  process.env.LITELLM_FAST_MODEL = 'stub-fast';
  delete process.env.RERANK_MODEL;

  // cm:guard the mocked module is imported and settled BEFORE anything that imports it — resolved concurrently inside one Promise.all, search-service received the real rerank.js while this file held the mock (two instances, measured 2026-09-04), and the holdout assertion failed on a service that drew at random
  const rerank = await import('../../src/memory/rerank.js');
  const [svc, routesMod, errMod, ridMod, jwtMod, emb] = await Promise.all([
    import('../../src/memory/search-service.js'),
    import('../../src/memory/search-routes.js'),
    import('../../src/middleware/error.js'),
    import('../../src/middleware/request-id.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/embeddings/index.js'),
  ]);
  runMemorySearch = svc.runMemorySearch;
  rerankMod = rerank;
  resetRerankCache = rerank.resetRerankCache;
  signUserToken = jwtMod.signUserToken;
  embeddingsMod = emb;
  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', ridMod.requestId());
  app.route('/api/memory', routesMod.memorySearchRoutes);
  app.onError(errMod.errorHandler);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  resetRerankCache();
  holdout.on = false;
  modelReplies.length = 0;
  modelRequests.length = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    modelRequests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    const content = modelReplies.shift() ?? '[]';
    return new Response(
      JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function stubQueryEmbedding(v: number[]) {
  const fake = {
    embed: vi.fn(async () => v),
    embedBatch: vi.fn(async () => [v]),
    resetBreaker: () => undefined,
  };
  embeddingsMod.resetEmbeddingsClient(
    fake as unknown as InstanceType<
      typeof import('../../src/embeddings/index.js').EmbeddingsClient
    >,
  );
}

async function project(): Promise<{ projectId: string; userId: string; token: string }> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const p = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, { userId: user.id, projectId: p.id, role: 'admin' });
  return { projectId: p.id, userId: user.id, token: await signUserToken(user.id) };
}

async function setFlags(projectId: string, f: { rerank?: boolean; expand?: boolean }) {
  await harness.db.execute(sql`
    INSERT INTO app_config (project_id, retrieval_rerank, retrieval_expand_relations)
    VALUES (${projectId}, ${f.rerank ?? false}, ${f.expand ?? false})
    ON CONFLICT (project_id) DO UPDATE
      SET retrieval_rerank = EXCLUDED.retrieval_rerank,
          retrieval_expand_relations = EXCLUDED.retrieval_expand_relations
  `);
}

async function insertMemory(
  projectId: string,
  m: { source: string; sourceRef: string; text: string; vec: number[]; archived?: boolean },
): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO memories (id, project_id, source, source_ref, text_content, embedding, metadata, archived_at)
    VALUES (${id}, ${projectId}, ${m.source}, ${m.sourceRef}, ${m.text},
            ${`[${m.vec.join(',')}]`}::vector, '{}'::jsonb, ${m.archived ? sql`now()` : sql`NULL`})
  `);
  return id;
}

async function insertIssue(
  projectId: string,
  userId: string,
  issSeq: number,
  title: string,
): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, created_by_id, iss_seq, title, status)
    VALUES (${id}, ${projectId}, ${userId}, ${issSeq}, ${title}, 'open')
  `);
  return id;
}

async function insertEdge(
  projectId: string,
  from: string,
  to: string,
  kind: string,
  validUntil: string | null = null,
) {
  await harness.db.execute(sql`
    INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind, valid_until)
    VALUES (${projectId}, ${from}, ${to}, ${kind}, ${validUntil}::timestamptz)
  `);
}

async function lastAnalytics(projectId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 40; i++) {
    const rows = await harness.db.execute<{ metadata: Record<string, unknown> }>(sql`
      SELECT metadata FROM retrieval_analytics WHERE project_id = ${projectId}
      ORDER BY created_at DESC LIMIT 1
    `);
    if (rows[0]) return rows[0].metadata;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no retrieval_analytics row was written');
}

/** m1 matches the query on both lists (RRF first); m2 on the semantic list only (RRF second). */
async function plantRerankPair(projectId: string) {
  const m1 = await insertMemory(projectId, {
    source: 'note',
    sourceRef: 'n1',
    text: 'alpha login flow',
    vec: vec([0]),
  });
  const m2 = await insertMemory(projectId, {
    source: 'note',
    sourceRef: 'n2',
    text: 'beta login flow',
    vec: vec([0, 1]),
  });
  stubQueryEmbedding(vec([0]));
  return { m1, m2 };
}

describe('rerank behind hybrid, per project flag', () => {
  it('flag off: RRF order, no model call, reranked false', async () => {
    const { projectId } = await project();
    const { m1, m2 } = await plantRerankPair(projectId);
    const res = await runMemorySearch({
      projectId,
      query: 'alpha',
      strategy: 'hybrid',
      surface: 'agent',
    });
    expect(res.hits.map((h) => h.id)).toEqual([m1, m2]);
    expect(res.reranked).toBe(false);
    expect(modelRequests).toHaveLength(0);
    expect(await lastAnalytics(projectId)).toMatchObject({ hitIds: [m1, m2] });
  });

  it('flag on: the fast model orders the hits, scores stay RRF, the row says reranked', async () => {
    const { projectId } = await project();
    await setFlags(projectId, { rerank: true });
    const { m1, m2 } = await plantRerankPair(projectId);
    modelReplies.push('[2, 1]');
    const res = await runMemorySearch({
      projectId,
      query: 'alpha',
      strategy: 'hybrid',
      surface: 'agent',
    });
    expect(res.hits.map((h) => h.id)).toEqual([m2, m1]);
    expect(res.hits.map((h) => h.rerankPosition)).toEqual([0, 1]);
    const scores = res.hits.map((h) => h.score);
    expect(scores).toHaveLength(2);
    expect(Math.min(...scores)).toBe(scores[0]);
    expect(res.reranked).toBe(true);
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]).toMatchObject({ model: 'stub-fast' });
    const md = await lastAnalytics(projectId);
    expect(md).toMatchObject({ reranked: true, hitIds: [m2, m1] });
    expect(typeof md.rerankMs).toBe('number');
  });

  it('flag on, web surface: never reranked', async () => {
    const { projectId } = await project();
    await setFlags(projectId, { rerank: true });
    const { m1, m2 } = await plantRerankPair(projectId);
    const res = await runMemorySearch({
      projectId,
      query: 'alpha',
      strategy: 'hybrid',
      surface: 'web',
    });
    expect(res.hits.map((h) => h.id)).toEqual([m1, m2]);
    expect(res.reranked).toBe(false);
    expect(modelRequests).toHaveLength(0);
  });

  it('flag on, holdout: RRF order and rerankHoldout on the response and the row', async () => {
    const { projectId } = await project();
    await setFlags(projectId, { rerank: true });
    const { m1, m2 } = await plantRerankPair(projectId);
    holdout.on = true;
    expect(rerankMod.inRerankHoldout()).toBe(true);
    const res = await runMemorySearch({
      projectId,
      query: 'alpha',
      strategy: 'hybrid',
      surface: 'agent',
    });
    expect(res.hits.map((h) => h.id)).toEqual([m1, m2]);
    expect(res.rerankHoldout).toBe(true);
    expect(modelRequests).toHaveLength(0);
    const md = await lastAnalytics(projectId);
    expect(md).toMatchObject({ rerankHoldout: true, hitIds: [m1, m2] });
    expect(md).not.toHaveProperty('reranked');
  });

  it('flag on, prose from the model: RRF order, reranked false, no error', async () => {
    const { projectId } = await project();
    await setFlags(projectId, { rerank: true });
    const { m1, m2 } = await plantRerankPair(projectId);
    modelReplies.push('The second passage is clearly the better match.');
    const res = await runMemorySearch({
      projectId,
      query: 'alpha',
      strategy: 'hybrid',
      surface: 'agent',
    });
    expect(res.hits.map((h) => h.id)).toEqual([m1, m2]);
    expect(res.reranked).toBe(false);
    expect(await lastAnalytics(projectId)).not.toHaveProperty('reranked');
  });
});

/** Issue A (ISS-1) blocks issue B (ISS-2); only A's memory matches the keyword query. */
async function plantBlocksPair(projectId: string, userId: string) {
  const a = await insertIssue(projectId, userId, 1, 'gamma widget');
  const b = await insertIssue(projectId, userId, 2, 'delta gadget');
  await insertEdge(projectId, a, b, 'blocks');
  const ma = await insertMemory(projectId, {
    source: 'issue',
    sourceRef: a,
    text: 'gamma widget',
    vec: vec([2]),
  });
  const mb = await insertMemory(projectId, {
    source: 'issue',
    sourceRef: b,
    text: 'delta gadget',
    vec: vec([3]),
  });
  return { a, b, ma, mb };
}

describe('one-hop relation expansion, per project flag', () => {
  it('flag off: only the matching issue comes back', async () => {
    const { projectId, userId } = await project();
    const { ma } = await plantBlocksPair(projectId, userId);
    const res = await runMemorySearch({
      projectId,
      query: 'gamma',
      strategy: 'keyword',
      surface: 'agent',
    });
    expect(res.hits.map((h) => h.id)).toEqual([ma]);
    expect(res.expanded).toBe(false);
  });

  it('flag on: the blocked neighbour is appended with via, score 0, after the ranked hit', async () => {
    const { projectId, userId } = await project();
    await setFlags(projectId, { expand: true });
    const { ma, mb } = await plantBlocksPair(projectId, userId);
    const res = await runMemorySearch({
      projectId,
      query: 'gamma',
      strategy: 'keyword',
      surface: 'agent',
    });
    expect(res.hits.map((h) => h.id)).toEqual([ma, mb]);
    expect(res.hits[1]).toMatchObject({ score: 0, via: { relation: 'blocks', from: 'ISS-1' } });
    expect(res.hits[0]).not.toHaveProperty('via');
    expect(res.expanded).toBe(true);
    expect(await lastAnalytics(projectId)).toMatchObject({ expanded: true, expandedCount: 1 });
  });

  it('an expired edge and an archived neighbour are not expanded', async () => {
    const { projectId, userId } = await project();
    await setFlags(projectId, { expand: true });
    const a = await insertIssue(projectId, userId, 1, 'gamma widget');
    const gone = await insertIssue(projectId, userId, 2, 'retracted');
    const archived = await insertIssue(projectId, userId, 3, 'archived');
    await insertEdge(projectId, a, gone, 'relates', '2020-01-01T00:00:00Z');
    await insertEdge(projectId, a, archived, 'relates');
    const ma = await insertMemory(projectId, {
      source: 'issue',
      sourceRef: a,
      text: 'gamma widget',
      vec: vec([2]),
    });
    await insertMemory(projectId, {
      source: 'issue',
      sourceRef: gone,
      text: 'retracted',
      vec: vec([3]),
    });
    await insertMemory(projectId, {
      source: 'issue',
      sourceRef: archived,
      text: 'archived',
      vec: vec([4]),
      archived: true,
    });
    const res = await runMemorySearch({
      projectId,
      query: 'gamma',
      strategy: 'keyword',
      surface: 'agent',
    });
    expect(res.hits.map((h) => h.id)).toEqual([ma]);
    expect(res.expanded).toBe(false);
  });

  it('reaches the web surface through POST /api/memory/search', async () => {
    const { projectId, userId, token } = await project();
    await setFlags(projectId, { expand: true });
    const { ma, mb } = await plantBlocksPair(projectId, userId);
    stubQueryEmbedding(vec([2]));
    const res = await app.request('/api/memory/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId, query: 'gamma', topK: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: Array<{ id: string; via?: unknown }>;
      expanded: boolean;
      reranked: boolean;
    };
    expect(body.hits.map((h) => h.id)).toEqual([ma, mb]);
    expect(body.hits[1]?.via).toEqual({ relation: 'blocks', from: 'ISS-1' });
    expect(body.expanded).toBe(true);
    expect(body.reranked).toBe(false);
  });
});
