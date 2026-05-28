import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  type TestDatabase,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// Phase 2.5-F3 integration — semantic memory search end-to-end.
// - Real Postgres with pgvector (testcontainer pgvector/pgvector:pg17).
// - Embeddings service is stubbed via resetEmbeddingsClient() so the route
//   does not hit a real LiteLLM instance.
// - Vectors are 1536-dim zero vectors with a single "hot" index set per row,
//   producing deterministic distance ordering.

const DIM = 1536;

function hotVector(hotIdx: number, mag = 1): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[hotIdx] = mag;
  return v;
}

describe('F3 memory search + indexer integration', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  let embeddingsMod: typeof import('../../src/embeddings/index.js');

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

    const { memorySearchRoutes } = await import('../../src/memory/search-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const jwtMod = await import('../../src/auth/jwt.js');
    embeddingsMod = await import('../../src/embeddings/index.js');
    signUserToken = jwtMod.signUserToken;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/memory', memorySearchRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seedMember(): Promise<{ userId: string; projectId: string; token: string }> {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'owner',
    });
    const token = await signUserToken(user.id);
    return { userId: user.id, projectId: project.id, token };
  }

  async function insertMemory(
    projectId: string,
    opts: { source: string; sourceRef: string; text: string; vec: number[] },
  ): Promise<void> {
    const vecLiteral = `[${opts.vec.join(',')}]`;
    await harness.db.execute(sql`
      INSERT INTO memories (project_id, source, source_ref, text_content, embedding, metadata)
      VALUES (${projectId}, ${opts.source}, ${opts.sourceRef}, ${opts.text}, ${vecLiteral}::vector, '{}'::jsonb)
    `);
  }

  function stubEmbedding(vec: number[]) {
    const fake = {
      embed: vi.fn(async () => vec),
      embedBatch: vi.fn(async () => [vec]),
      resetBreaker: () => undefined,
    };
    embeddingsMod.resetEmbeddingsClient(
      fake as unknown as InstanceType<
        typeof import('../../src/embeddings/index.js').EmbeddingsClient
      >,
    );
  }

  // ---------- SEARCH ----------

  it('search: 401 without token', async () => {
    const { projectId } = await seedMember();
    const res = await app.request('/api/memory/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, query: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('search: 403 when user is not a project member', async () => {
    const { projectId } = await seedMember();
    const stranger = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger.id}`,
    );
    const strangerToken = await signUserToken(stranger.id);
    stubEmbedding(hotVector(0));
    const res = await app.request('/api/memory/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${strangerToken}`,
      },
      body: JSON.stringify({ projectId, query: 'hi' }),
    });
    expect(res.status).toBe(403);
  });

  it('search: 400 on invalid body', async () => {
    const { token } = await seedMember();
    const res = await app.request('/api/memory/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ projectId: 'not-a-uuid', query: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('search: happy path returns hits ordered by score (higher similarity first)', async () => {
    const { projectId, token } = await seedMember();

    // Seed three memories with distinct "hot" indices.
    await insertMemory(projectId, {
      source: 'issue',
      sourceRef: randomUUID(),
      text: 'auth login flow',
      vec: hotVector(0),
    });
    await insertMemory(projectId, {
      source: 'comment',
      sourceRef: randomUUID(),
      text: 'unrelated text',
      vec: hotVector(500),
    });
    await insertMemory(projectId, {
      source: 'issue',
      sourceRef: randomUUID(),
      text: 'billing page',
      vec: hotVector(1000),
    });

    // Query aligns with index 0 (the "auth login" memory).
    stubEmbedding(hotVector(0));

    const res = await app.request('/api/memory/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ projectId, query: 'auth', topK: 3 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: Array<{ text: string; score: number; source: string }>;
      model: string;
      took_ms: number;
    };
    expect(body.hits).toHaveLength(3);
    expect(body.hits[0]?.text).toBe('auth login flow');
    // Scores are monotonically non-increasing (distance ascending).
    for (let i = 1; i < body.hits.length; i++) {
      expect(body.hits[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(body.hits[i]?.score ?? 0);
    }
    expect(body.model).toBeTruthy();
    expect(typeof body.took_ms).toBe('number');
  });

  it('search: sourceFilter narrows results', async () => {
    const { projectId, token } = await seedMember();
    await insertMemory(projectId, {
      source: 'issue',
      sourceRef: randomUUID(),
      text: 'an issue',
      vec: hotVector(0),
    });
    await insertMemory(projectId, {
      source: 'comment',
      sourceRef: randomUUID(),
      text: 'a comment',
      vec: hotVector(1),
    });

    stubEmbedding(hotVector(0));

    const res = await app.request('/api/memory/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ projectId, query: 'q', sourceFilter: ['comment'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ source: string }> };
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]?.source).toBe('comment');
  });

  it('search: project scoping — hits from another project are not returned', async () => {
    const a = await seedMember();
    const b = await seedMember();
    await insertMemory(a.projectId, {
      source: 'issue',
      sourceRef: randomUUID(),
      text: 'project A memory',
      vec: hotVector(0),
    });
    await insertMemory(b.projectId, {
      source: 'issue',
      sourceRef: randomUUID(),
      text: 'project B memory',
      vec: hotVector(0),
    });

    stubEmbedding(hotVector(0));

    const res = await app.request('/api/memory/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${a.token}`,
      },
      body: JSON.stringify({ projectId: a.projectId, query: 'q' }),
    });
    const body = (await res.json()) as { hits: Array<{ text: string }> };
    expect(body.hits.map((h) => h.text)).toEqual(['project A memory']);
  });

  it('search: 503 when embeddings circuit breaker is open', async () => {
    const { projectId, token } = await seedMember();
    const { EmbeddingUnavailableError } = embeddingsMod;
    const fake = {
      embed: vi.fn(async () => {
        throw new EmbeddingUnavailableError('breaker open');
      }),
      embedBatch: vi.fn(),
      resetBreaker: () => undefined,
    };
    embeddingsMod.resetEmbeddingsClient(
      fake as unknown as InstanceType<typeof embeddingsMod.EmbeddingsClient>,
    );

    const res = await app.request('/api/memory/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ projectId, query: 'q' }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('EMBEDDING_UNAVAILABLE');
  });

  // ---------- INDEXER ----------

  async function registerIndexerFresh() {
    const { hooks } = await import('../../src/pipeline/hooks.js');
    const { registerMemoryIndexer, resetMemoryIndexerRegistration } = await import(
      '../../src/memory/indexer.js'
    );
    hooks.reset();
    resetMemoryIndexerRegistration();
    registerMemoryIndexer(hooks);
    return { hooks };
  }

  it('indexer: issueCreated hook upserts a memory row', async () => {
    const { projectId } = await seedMember();
    const { hooks } = await registerIndexerFresh();
    stubEmbedding(hotVector(0));

    const issueId = randomUUID();
    await hooks.emit('issueCreated', {
      issueId,
      projectId,
      actor: { type: 'user', id: randomUUID() },
      status: 'open',
      snapshot: {
        title: 'test issue',
        description: 'body',
        priority: 'medium',
        category: null,
        reportedBy: null,
        assigneeId: null,
        labels: [],
      },
    });

    // queueMicrotask detaches — allow the microtask to run.
    await new Promise((r) => setTimeout(r, 50));

    const rows = await harness.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM memories WHERE project_id = ${projectId} AND source = 'issue' AND source_ref = ${issueId}`,
    );
    expect((rows[0] as { count: string }).count).toBe('1');
  });

  it('indexer: issueUpdated only re-embeds when title/description change', async () => {
    const { projectId } = await seedMember();
    const { hooks } = await registerIndexerFresh();

    let embedCalls = 0;
    const fake = {
      embed: vi.fn(async () => {
        embedCalls++;
        return hotVector(0);
      }),
      embedBatch: vi.fn(),
      resetBreaker: () => undefined,
    };
    embeddingsMod.resetEmbeddingsClient(
      fake as unknown as InstanceType<typeof embeddingsMod.EmbeddingsClient>,
    );

    const issueId = randomUUID();
    const actor = { type: 'user' as const, id: randomUUID() };

    // Priority-only update should NOT re-embed.
    await hooks.emit('issueUpdated', {
      issueId,
      projectId,
      actor,
      fields: ['priority'],
      before: { priority: 'low' },
      after: { priority: 'high' },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(embedCalls).toBe(0);

    // Title update should re-embed.
    await hooks.emit('issueUpdated', {
      issueId,
      projectId,
      actor,
      fields: ['title'],
      before: { title: 'old' },
      after: { title: 'new', description: '' },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(embedCalls).toBe(1);
  });

  it('indexer: commentCreated hook upserts a memory row', async () => {
    const { projectId } = await seedMember();
    const { hooks } = await registerIndexerFresh();
    stubEmbedding(hotVector(0));

    const commentId = randomUUID();
    await hooks.emit('commentCreated', {
      issueId: randomUUID(),
      projectId,
      actor: { type: 'user', id: randomUUID() },
      commentId,
      body: 'comment body',
    });
    await new Promise((r) => setTimeout(r, 50));

    const rows = await harness.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM memories WHERE source_ref = ${commentId} AND source = 'comment'`,
    );
    expect((rows[0] as { count: string }).count).toBe('1');
  });

  it('indexer: commentUpdated re-embeds with the new body', async () => {
    const { projectId } = await seedMember();
    const { hooks } = await registerIndexerFresh();

    const commentId = randomUUID();
    let lastEmbedText = '';
    const fake = {
      embed: vi.fn(async (text: string) => {
        lastEmbedText = text;
        return hotVector(0);
      }),
      embedBatch: vi.fn(),
      resetBreaker: () => undefined,
    };
    embeddingsMod.resetEmbeddingsClient(
      fake as unknown as InstanceType<typeof embeddingsMod.EmbeddingsClient>,
    );

    await hooks.emit('commentUpdated', {
      issueId: randomUUID(),
      projectId,
      actor: { type: 'user', id: randomUUID() },
      commentId,
      before: 'old text',
      after: 'new text',
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastEmbedText).toBe('new text');
  });

  it('indexer: registerMemoryIndexer is idempotent — double-call does not double-subscribe', async () => {
    const { projectId } = await seedMember();
    const { hooks } = await registerIndexerFresh();
    const { registerMemoryIndexer } = await import('../../src/memory/indexer.js');
    // Second call should be a no-op; only one subscription must exist.
    registerMemoryIndexer(hooks);
    registerMemoryIndexer(hooks);

    let embedCalls = 0;
    const fake = {
      embed: vi.fn(async () => {
        embedCalls++;
        return hotVector(0);
      }),
      embedBatch: vi.fn(),
      resetBreaker: () => undefined,
    };
    embeddingsMod.resetEmbeddingsClient(
      fake as unknown as InstanceType<typeof embeddingsMod.EmbeddingsClient>,
    );

    await hooks.emit('issueCreated', {
      issueId: randomUUID(),
      projectId,
      actor: { type: 'user', id: randomUUID() },
      status: 'open',
      snapshot: {
        title: 'idempotent',
        description: null,
        priority: 'medium',
        category: null,
        reportedBy: null,
        assigneeId: null,
        labels: [],
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(embedCalls).toBe(1);
  });

  it('indexer: commentDeleted removes the memory row', async () => {
    const { projectId } = await seedMember();
    const { hooks } = await registerIndexerFresh();

    const commentId = randomUUID();
    await insertMemory(projectId, {
      source: 'comment',
      sourceRef: commentId,
      text: 'doomed',
      vec: hotVector(0),
    });

    await hooks.emit('commentDeleted', {
      issueId: randomUUID(),
      projectId,
      actor: { type: 'user', id: randomUUID() },
      commentId,
    });
    await new Promise((r) => setTimeout(r, 30));

    const rows = await harness.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM memories WHERE source_ref = ${commentId}`,
    );
    expect((rows[0] as { count: string }).count).toBe('0');
  });
});
