import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  type TestDatabase,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// Live E2E coverage — exercises the REAL embedding provider (LiteLLM proxy).
// Skipped automatically when EMBEDDINGS_BASE_URL/EMBEDDINGS_API_KEY are not
// set, so this file is safe to leave in the suite. Run via:
//
//   set -a; source ../../.env; set +a
//   TEST_DB_MODE=container pnpm exec vitest run \
//     --config vitest.integration.config.ts tests/integration/memory-live.test.ts
//
// Verifies:
//   - request body carries `dimensions` (Matryoshka truncate via LiteLLM)
//   - response embedding length matches EMBEDDINGS_DIM, persists into pgvector
//   - semantic search ranks the obviously-correct hit first
//   - multilingual content (Vietnamese + English) round-trips correctly
//   - upsert refreshes the embedding when text changes

const HAS_LIVE_ENV = !!process.env.EMBEDDINGS_BASE_URL && !!process.env.EMBEDDINGS_API_KEY;
const describeIfLive = HAS_LIVE_ENV ? describe : describe.skip;

describeIfLive('memory live E2E (real embeddings)', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  let embeddingsMod: typeof import('../../src/embeddings/index.js');
  const EXPECTED_DIM = Number(process.env.EMBEDDINGS_DIM ?? '1536');

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

    const { memoryWriteRoutes } = await import('../../src/memory/write-routes.js');
    const { memoryListRoutes } = await import('../../src/memory/list-routes.js');
    const { memorySearchRoutes } = await import('../../src/memory/search-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const jwtMod = await import('../../src/auth/jwt.js');
    embeddingsMod = await import('../../src/embeddings/index.js');
    signUserToken = jwtMod.signUserToken;

    // CRITICAL: do NOT call resetEmbeddingsClient — we want the real client
    // built from EMBEDDINGS_BASE_URL/API_KEY.
    embeddingsMod.resetEmbeddingsClient();

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/memory', memoryWriteRoutes);
    app.route('/api/memory', memoryListRoutes);
    app.route('/api/memory', memorySearchRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seedMember(): Promise<{ projectId: string; token: string }> {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    const token = await signUserToken(user.id);
    return { projectId: project.id, token };
  }

  async function postMemory(token: string, payload: Record<string, unknown>): Promise<Response> {
    return app.request('/api/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
  }

  async function searchMemory(token: string, payload: Record<string, unknown>): Promise<Response> {
    return app.request('/api/memory/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
  }

  it(`write persists a real ${EXPECTED_DIM}-dim embedding into pgvector`, async () => {
    const { projectId, token } = await seedMember();

    const res = await postMemory(token, {
      projectId,
      source: 'note',
      sourceRef: 'live-1',
      textContent: 'hello forge from live E2E test',
    });
    expect(res.status).toBe(201);

    const rows = await harness.db.execute(sql`
      SELECT vector_dims(embedding) AS dims, length(text_content) AS text_len
      FROM memories
      WHERE project_id = ${projectId} AND source_ref = 'live-1'
    `);
    expect(rows.length).toBe(1);
    expect(Number(rows[0]?.dims)).toBe(EXPECTED_DIM);
  });

  it('semantic search ranks the obviously-relevant memory first (English)', async () => {
    const { projectId, token } = await seedMember();

    await postMemory(token, {
      projectId,
      source: 'note',
      sourceRef: 'auth',
      textContent: 'user authentication and login flow with JWT tokens',
    });
    await postMemory(token, {
      projectId,
      source: 'note',
      sourceRef: 'billing',
      textContent: 'monthly billing invoice generation and payment processing',
    });
    await postMemory(token, {
      projectId,
      source: 'note',
      sourceRef: 'search',
      textContent: 'full text search across product catalog and filters',
    });

    const res = await searchMemory(token, {
      projectId,
      query: 'how do users sign in',
      topK: 3,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: Array<{ sourceRef: string; text: string; score: number }>;
    };
    expect(body.hits.length).toBe(3);
    // Top-1 must be the auth row — the only one about sign-in.
    expect(body.hits[0]?.sourceRef).toBe('auth');
    // Sanity: scores monotonically non-increasing.
    for (let i = 1; i < body.hits.length; i++) {
      expect(body.hits[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(body.hits[i]?.score ?? 0);
    }
  });

  it('semantic search works for Vietnamese content (multilingual round-trip)', async () => {
    const { projectId, token } = await seedMember();

    await postMemory(token, {
      projectId,
      source: 'note',
      sourceRef: 'dn',
      textContent: 'đăng nhập người dùng bằng email và mật khẩu, hỗ trợ JWT',
    });
    await postMemory(token, {
      projectId,
      source: 'note',
      sourceRef: 'tt',
      textContent: 'thanh toán hóa đơn hàng tháng qua thẻ tín dụng',
    });
    await postMemory(token, {
      projectId,
      source: 'note',
      sourceRef: 'tk',
      textContent: 'tìm kiếm sản phẩm trong danh mục với bộ lọc giá',
    });

    const res = await searchMemory(token, {
      projectId,
      query: 'làm sao để người dùng đăng nhập vào hệ thống',
      topK: 3,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ sourceRef: string }> };
    expect(body.hits[0]?.sourceRef).toBe('dn');
  });

  it('upsert refreshes the embedding when text changes (same key)', async () => {
    const { projectId, token } = await seedMember();
    const ref = 'refresh-test';

    // v1 — talk about cats.
    await postMemory(token, {
      projectId,
      source: 'note',
      sourceRef: ref,
      textContent: 'fluffy domestic cats prefer canned tuna in the morning',
    });
    const r1 = await searchMemory(token, { projectId, query: 'feline pet food', topK: 1 });
    const b1 = (await r1.json()) as { hits: Array<{ score: number }> };
    const scoreCats = b1.hits[0]?.score ?? 0;

    // v2 — same key, now about database indexing.
    await postMemory(token, {
      projectId,
      source: 'note',
      sourceRef: ref,
      textContent: 'btree indexes accelerate equality lookups on indexed columns',
    });
    const r2 = await searchMemory(token, { projectId, query: 'feline pet food', topK: 1 });
    const b2 = (await r2.json()) as { hits: Array<{ score: number }> };
    const scoreDb = b2.hits[0]?.score ?? 0;

    // Same key after upsert returns the new (DB-topic) row. Its cosine
    // similarity to "feline pet food" must be lower than the cats version.
    expect(scoreDb).toBeLessThan(scoreCats);

    // Exactly one row in the DB.
    const rows = await harness.db.execute(sql`
      SELECT COUNT(*)::int AS n FROM memories
      WHERE project_id = ${projectId} AND source_ref = ${ref}
    `);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('delete makes the row disappear from semantic search', async () => {
    const { projectId, token } = await seedMember();

    await postMemory(token, {
      projectId,
      source: 'note',
      sourceRef: 'to-delete',
      textContent: 'unique sentinel sentence about quantum entanglement',
    });

    // Sanity: found before delete.
    const before = await searchMemory(token, {
      projectId,
      query: 'quantum entanglement',
      topK: 5,
    });
    const beforeBody = (await before.json()) as { hits: Array<{ sourceRef: string }> };
    expect(beforeBody.hits.some((h) => h.sourceRef === 'to-delete')).toBe(true);

    // Delete.
    const del = await app.request(
      `/api/memory/by-source?projectId=${projectId}&source=note&sourceRef=to-delete`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    );
    expect(del.status).toBe(200);

    // Gone.
    const after = await searchMemory(token, {
      projectId,
      query: 'quantum entanglement',
      topK: 5,
    });
    const afterBody = (await after.json()) as { hits: Array<{ sourceRef: string }> };
    expect(afterBody.hits.some((h) => h.sourceRef === 'to-delete')).toBe(false);
  });

  it('handles step_handoff with structured metadata + JSON content', async () => {
    const { projectId, token } = await seedMember();
    const handoffJson = JSON.stringify({
      step: 'plan',
      schema_version: 1,
      planSummary: 'Refactor auth middleware to read JWT from cookie OR header',
      affectedFiles: ['src/middleware/auth.ts', 'src/auth/jwt.ts'],
      acceptanceChecklist: ['401 on missing token', '200 on valid cookie', 'tests green'],
      unknowns: [],
    });

    const res = await postMemory(token, {
      projectId,
      source: 'step_handoff',
      sourceRef: 'run:abc/step:plan/attempt:1',
      textContent: handoffJson,
      metadata: { run_id: 'abc', step: 'plan', attempt: 1 },
    });
    expect(res.status).toBe(201);

    // Direct metadata-filter lookup (forge_memory.get path).
    const getRes = await app.request(`/api/memory?projectId=${projectId}&source=step_handoff`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.status).toBe(200);
    const rows = (await getRes.json()) as Array<{ metadata: Record<string, unknown> }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.metadata).toMatchObject({ run_id: 'abc', step: 'plan', attempt: 1 });

    // Semantic search by intent (not exact text) still finds the handoff.
    const search = await searchMemory(token, {
      projectId,
      query: 'auth middleware cookie token refactor plan',
      topK: 3,
      sourceFilter: ['step_handoff'],
    });
    const hits = ((await search.json()) as { hits: Array<{ sourceRef: string }> }).hits;
    expect(hits[0]?.sourceRef).toBe('run:abc/step:plan/attempt:1');
  });
});
