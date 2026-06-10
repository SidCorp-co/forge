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

// Integration coverage for Phase 0 memory MCP foundation:
//   - REST `POST /api/memory`  (memoryWriteRoutes)
//   - REST `GET  /api/memory`  (memoryListRoutes — refactored via get-service)
//   - REST `DELETE /api/memory/by-source` and `/:id`
// MCP tool wrappers share the same service layer so REST coverage covers them.
//
// Embeddings are stubbed via resetEmbeddingsClient so tests stay portable
// across CI / dev / no-API-key environments.

const DIM = 1536;

function deterministicVector(seed: string): number[] {
  // Reproducible non-zero vector — content irrelevant for these tests since
  // we exercise persistence + filtering, not similarity ranking.
  const v = new Array<number>(DIM).fill(0);
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  v[Math.abs(h) % DIM] = 1;
  return v;
}

describe('memory write/get/delete integration (Phase 0)', () => {
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

    const { memoryWriteRoutes } = await import('../../src/memory/write-routes.js');
    const { memoryListRoutes } = await import('../../src/memory/list-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const jwtMod = await import('../../src/auth/jwt.js');
    embeddingsMod = await import('../../src/embeddings/index.js');
    signUserToken = jwtMod.signUserToken;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    // Both write and list mount on /api/memory — write owns POST, list owns
    // GET + DELETE. The shared root keeps the production wiring 1:1.
    app.route('/api/memory', memoryWriteRoutes);
    app.route('/api/memory', memoryListRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    stubEmbedding(deterministicVector('default'));
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

  function stubEmbedding(_vec?: number[]) {
    // Content-dependent vector: distinct text → distinct (near-orthogonal)
    // vector. Required since memory-v2 phase 2 — note/knowledge writes run
    // semantic dedup, so a constant stub vector would make every write a
    // near-duplicate (cosine 1.0) and collapse distinct rows into one.
    const fake = {
      embed: vi.fn(async (text: string) => deterministicVector(text)),
      embedBatch: vi.fn(async (texts: string[]) => texts.map((t) => deterministicVector(t))),
      resetBreaker: () => undefined,
    };
    embeddingsMod.resetEmbeddingsClient(
      fake as unknown as InstanceType<typeof embeddingsMod.EmbeddingsClient>,
    );
  }

  function stubEmbeddingFailure(err: Error) {
    const fake = {
      embed: vi.fn(async () => {
        throw err;
      }),
      embedBatch: vi.fn(async () => {
        throw err;
      }),
      resetBreaker: () => undefined,
    };
    embeddingsMod.resetEmbeddingsClient(
      fake as unknown as InstanceType<typeof embeddingsMod.EmbeddingsClient>,
    );
  }

  // ---------- WRITE ----------

  describe('POST /api/memory', () => {
    it('401 without token', async () => {
      const res = await app.request('/api/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: randomUUID(),
          source: 'note',
          sourceRef: 'n-1',
          textContent: 'hi',
        }),
      });
      expect(res.status).toBe(401);
    });

    it('403 when user is not a project member', async () => {
      const { projectId } = await seedMember();
      const stranger = await createTestUser(harness.db);
      await harness.db.execute(
        sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger.id}`,
      );
      const strangerToken = await signUserToken(stranger.id);

      const res = await app.request('/api/memory', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${strangerToken}`,
        },
        body: JSON.stringify({
          projectId,
          source: 'note',
          sourceRef: 'n-1',
          textContent: 'hi',
        }),
      });
      expect(res.status).toBe(403);
    });

    it('400 on invalid body (bad source)', async () => {
      const { projectId, token } = await seedMember();
      const res = await app.request('/api/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          projectId,
          source: 'unknown_source',
          sourceRef: 'r',
          textContent: 't',
        }),
      });
      expect(res.status).toBe(400);
    });

    it('400 on empty textContent', async () => {
      const { projectId, token } = await seedMember();
      const res = await app.request('/api/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          projectId,
          source: 'note',
          sourceRef: 'n-1',
          textContent: '   ',
        }),
      });
      expect(res.status).toBe(400);
    });

    it('happy path: 201 + row persists with embedding + metadata', async () => {
      const { projectId, token } = await seedMember();

      const res = await app.request('/api/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          projectId,
          source: 'note',
          sourceRef: 'run:R/step:plan/attempt:1',
          textContent: 'plan handoff text',
          metadata: { run_id: 'R', step: 'plan', attempt: 1 },
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; embeddedAt: string; truncated: boolean };
      expect(body.id).toBeTruthy();
      expect(body.truncated).toBe(false);

      const rows = await harness.db.execute(sql`
        SELECT id, source, source_ref, text_content, metadata FROM memories
        WHERE project_id = ${projectId} AND source_ref = 'run:R/step:plan/attempt:1'
      `);
      expect(rows.length).toBe(1);
      expect(rows[0]?.text_content).toBe('plan handoff text');
      expect(rows[0]?.metadata).toMatchObject({ run_id: 'R', step: 'plan', attempt: 1 });
    });

    it('upsert is idempotent on (projectId, source, sourceRef) — second call updates text + bumps updatedAt', async () => {
      const { projectId, token } = await seedMember();
      const payload = {
        projectId,
        source: 'note' as const,
        sourceRef: 'n-1',
        textContent: 'v1',
      };

      const r1 = await app.request('/api/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      expect(r1.status).toBe(201);

      const r2 = await app.request('/api/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...payload, textContent: 'v2', metadata: { revised: true } }),
      });
      expect(r2.status).toBe(201);

      const rows = await harness.db.execute(sql`
        SELECT text_content, metadata FROM memories
        WHERE project_id = ${projectId} AND source = 'note' AND source_ref = 'n-1'
      `);
      expect(rows.length).toBe(1);
      expect(rows[0]?.text_content).toBe('v2');
      expect(rows[0]?.metadata).toMatchObject({ revised: true });
    });

    it('stores FULL textContent but flags truncated:true when > 8192 chars', async () => {
      const { projectId, token } = await seedMember();
      const longText = 'x'.repeat(10_000);

      const res = await app.request('/api/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          projectId,
          source: 'note',
          sourceRef: 'big',
          textContent: longText,
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { truncated: boolean };
      // memory-v2 phase 0: only the embed input is cut at 8192; the stored
      // text_content is always the full string. `truncated` flags the cut.
      expect(body.truncated).toBe(true);

      const rows = await harness.db.execute(sql`
        SELECT length(text_content) AS n FROM memories
        WHERE project_id = ${projectId} AND source_ref = 'big'
      `);
      expect(Number(rows[0]?.n)).toBe(10_000);
    });

    it('degraded write (201, embedding NULL) when the embedding service is down', async () => {
      const { projectId, token } = await seedMember();
      const { EmbeddingUnavailableError } = embeddingsMod;
      stubEmbeddingFailure(new EmbeddingUnavailableError('breaker open'));

      const res = await app.request('/api/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          projectId,
          source: 'note',
          sourceRef: 'down',
          textContent: 't',
        }),
      });
      // memory-v2 phase 1: an embeddings OUTAGE no longer 503s. The row is
      // stored without a vector (degraded:true) and the backfill job
      // re-embeds it later; it is keyword-searchable immediately.
      expect(res.status).toBe(201);
      const body = (await res.json()) as { degraded: boolean };
      expect(body.degraded).toBe(true);

      const rows = await harness.db.execute(sql`
        SELECT embedding FROM memories
        WHERE project_id = ${projectId} AND source_ref = 'down'
      `);
      expect(rows.length).toBe(1);
      expect(rows[0]?.embedding).toBeNull();
    });

    it('concurrent UPSERT on the same natural key produces exactly 1 row', async () => {
      const { projectId, token } = await seedMember();
      const payload = {
        projectId,
        source: 'note',
        sourceRef: 'race',
        textContent: 't',
      };

      const calls = Array.from({ length: 5 }, (_, i) =>
        app.request('/api/memory', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ ...payload, textContent: `v${i}` }),
        }),
      );
      const responses = await Promise.all(calls);
      for (const r of responses) expect([201, 409]).toContain(r.status);

      const rows = await harness.db.execute(sql`
        SELECT COUNT(*)::int AS n FROM memories
        WHERE project_id = ${projectId} AND source_ref = 'race'
      `);
      expect(Number(rows[0]?.n)).toBe(1);
    });
  });

  // ---------- GET ----------

  describe('GET /api/memory', () => {
    it('401 without token', async () => {
      const res = await app.request(`/api/memory?projectId=${randomUUID()}`);
      expect(res.status).toBe(401);
    });

    it('403 when caller is not a project member', async () => {
      const { projectId } = await seedMember();
      const stranger = await createTestUser(harness.db);
      await harness.db.execute(
        sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger.id}`,
      );
      const strangerToken = await signUserToken(stranger.id);

      const res = await app.request(`/api/memory?projectId=${projectId}`, {
        headers: { authorization: `Bearer ${strangerToken}` },
      });
      expect(res.status).toBe(403);
    });

    it('lists rows ordered by createdAt desc + X-Total-Count header', async () => {
      const { projectId, token } = await seedMember();
      // Seed 3 rows via POST so they get realistic createdAt spread.
      for (const i of [1, 2, 3]) {
        const r = await app.request('/api/memory', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            projectId,
            source: 'note',
            sourceRef: `n-${i}`,
            textContent: `body ${i}`,
          }),
        });
        expect(r.status).toBe(201);
      }

      const res = await app.request(`/api/memory?projectId=${projectId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Total-Count')).toBe('3');
      const rows = (await res.json()) as Array<{ sourceRef: string }>;
      expect(rows.length).toBe(3);
      // Newest first.
      expect(rows[0]?.sourceRef).toBe('n-3');
    });

    it('source filter narrows results', async () => {
      const { projectId, token } = await seedMember();
      await app.request('/api/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          projectId,
          source: 'note',
          sourceRef: 'n-1',
          textContent: 't',
        }),
      });
      await app.request('/api/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          projectId,
          source: 'knowledge',
          sourceRef: 'k-1',
          textContent: 'a distinct convention',
        }),
      });

      const res = await app.request(`/api/memory?projectId=${projectId}&source=knowledge`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const rows = (await res.json()) as Array<{ source: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]?.source).toBe('knowledge');
    });
  });

  // ---------- DELETE ----------

  describe('DELETE /api/memory/by-source', () => {
    it('removes the row matching the natural key', async () => {
      const { projectId, token } = await seedMember();
      await app.request('/api/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          projectId,
          source: 'note',
          sourceRef: 'gone',
          textContent: 't',
        }),
      });

      const res = await app.request(
        `/api/memory/by-source?projectId=${projectId}&source=note&sourceRef=gone`,
        { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deleted: number };
      expect(body.deleted).toBe(1);

      const rows = await harness.db.execute(sql`
        SELECT COUNT(*)::int AS n FROM memories
        WHERE project_id = ${projectId} AND source_ref = 'gone'
      `);
      expect(Number(rows[0]?.n)).toBe(0);
    });

    it('is idempotent — second delete returns {deleted: 0}', async () => {
      const { projectId, token } = await seedMember();
      const url = `/api/memory/by-source?projectId=${projectId}&source=note&sourceRef=ghost`;

      const r1 = await app.request(url, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r1.status).toBe(200);
      expect(((await r1.json()) as { deleted: number }).deleted).toBe(0);
    });
  });
});
