// Retrieval v3 phase 2 (ISS-906) against a real Postgres: a project flips to the
// chunked memory model through the admin operation, the reindex job publishes
// passages generation by generation, the read path unions the chunk arm with
// the not-yet-chunked flat arm, writes on a chunked project stay atomic under
// an embeddings outage, and a revert cancels + schedules the purge.
//
// Embeddings are a fake whose vector depends on the FIRST 2,000 characters of the
// text it embeds, so a marker buried in the last paragraph of a long body is
// invisible to the whole-document vector and visible to the passage that holds
// it — the failure the chunked model exists to remove.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type RequestIdVars = import('../../src/middleware/request-id.js').RequestIdVars;

const sends = vi.hoisted(() => [] as Array<{ queue: string; data: unknown; opts: unknown }>);
vi.mock('../../src/queue/boss.js', () => ({
  boss: {
    send: async (queue: string, data: unknown, opts: unknown) => {
      sends.push({ queue, data, opts });
      return randomUUID();
    },
  },
  isBossStarted: () => false,
  stopBoss: async () => undefined,
}));

const MARKER = 'zanzibar';
const DIM = 1536;
// cm:guard HEAD_CHARS must exceed CHUNK_MAX_CHARS plus the longest context prefix and stay well below the long body's marker offset (~5,900) — a passage that holds the marker must embed hot while the whole document embeds cold, or the flip proves nothing
const HEAD_CHARS = 2000;

/** Outage switch and call counter for the fake embeddings client. */
const fake = { outage: false, calls: 0, onCall: null as null | ((n: number) => Promise<void>) };

function vecFor(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[text.slice(0, HEAD_CHARS).includes(MARKER) ? 7 : 0] = 1;
  return v;
}

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let indexMemory: typeof import('../../src/memory/indexer.js').indexMemory;
let runMemorySearch: typeof import('../../src/memory/search-service.js').runMemorySearch;
let reindexMod: typeof import('../../src/memory/chunk-reindex.js');
let backfillMod: typeof import('../../src/memory/embedding-backfill.js');
let chunkerMod: typeof import('../../src/memory/chunker.js');
let EmbeddingUnavailableError: typeof import('../../src/embeddings/index.js').EmbeddingUnavailableError;

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

  // cm:guard the mocked boss module is imported and settled BEFORE the modules that import it — concurrent imports inside one Promise.all hand a consumer the real module (measured 2026-09-04 on rerank.js in the sibling e2e)
  await import('../../src/queue/boss.js');
  const emb = await import('../../src/embeddings/index.js');
  EmbeddingUnavailableError = emb.EmbeddingUnavailableError;
  const embedOne = async (text: string) => {
    fake.calls += 1;
    if (fake.onCall) await fake.onCall(fake.calls);
    if (fake.outage) throw new EmbeddingUnavailableError('embeddings outage (test)');
    return vecFor(text);
  };
  emb.resetEmbeddingsClient({
    embed: embedOne,
    embedBatch: async (texts: string[]) => {
      const out: number[][] = [];
      for (const t of texts) out.push(await embedOne(t));
      return out;
    },
    resetBreaker: () => undefined,
  } as unknown as InstanceType<typeof emb.EmbeddingsClient>);

  const [idx, svc, rx, bf, ch, routesMod, cfgRoutes, errMod, ridMod, jwtMod] = await Promise.all([
    import('../../src/memory/indexer.js'),
    import('../../src/memory/search-service.js'),
    import('../../src/memory/chunk-reindex.js'),
    import('../../src/memory/embedding-backfill.js'),
    import('../../src/memory/chunker.js'),
    import('../../src/app-config/memory-model-routes.js'),
    import('../../src/app-config/routes.js'),
    import('../../src/middleware/error.js'),
    import('../../src/middleware/request-id.js'),
    import('../../src/auth/jwt.js'),
  ]);
  indexMemory = idx.indexMemory;
  runMemorySearch = svc.runMemorySearch;
  reindexMod = rx;
  backfillMod = bf;
  chunkerMod = ch;
  signUserToken = jwtMod.signUserToken;
  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', ridMod.requestId());
  app.route('/api/app-config', routesMod.memoryModelRoutes);
  app.route('/api/app-config', cfgRoutes.appConfigRoutes);
  app.onError(errMod.errorHandler);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  sends.length = 0;
  fake.outage = false;
  fake.calls = 0;
  fake.onCall = null;
});

async function project(role: 'admin' | 'member' = 'admin') {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const p = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, { userId: user.id, projectId: p.id, role });
  return { projectId: p.id, token: await signUserToken(user.id) };
}

const json = (token: string) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
});

const post = (projectId: string, token: string, model: string) =>
  app.request(`/api/app-config/${projectId}/memory-model`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ model }),
  });

/** ~6,000 characters of filler paragraphs; only the LAST paragraph carries the marker. */
function longBody(marker = MARKER): string {
  const para = 'The dispatcher reads the runner table and picks a slot with capacity left. '.repeat(
    9,
  );
  const paras = Array.from({ length: 8 }, (_, i) => `Section ${i + 1}. ${para.trim()}`);
  paras.push(`Closing note: the ${marker} cache key is derived from the passage hash.`);
  return paras.join('\n\n');
}

async function rowState(projectId: string, sourceRef: string) {
  const [m] = await harness.db.execute<{
    id: string;
    chunk_generation: number;
    chunked_at: Date | null;
  }>(
    sql`SELECT id, chunk_generation, chunked_at FROM memories
        WHERE project_id = ${projectId} AND source_ref = ${sourceRef}`,
  );
  if (!m) throw new Error('memory row missing');
  const chunks = await harness.db.execute<{ generation: number; chunk_index: number }>(
    sql`SELECT generation, chunk_index FROM memory_chunks WHERE memory_id = ${m.id} ORDER BY chunk_index`,
  );
  return { ...m, chunks: [...chunks] };
}

async function setModel(projectId: string, model: 'flat' | 'chunked') {
  await harness.db.execute(sql`
    INSERT INTO app_config (project_id, memory_model) VALUES (${projectId}, ${model})
    ON CONFLICT (project_id) DO UPDATE SET memory_model = EXCLUDED.memory_model`);
}

async function plantFlat(projectId: string, source: string, text: string) {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO memories (id, project_id, source, source_ref, text_content, embedding, embedded_at)
    VALUES (${id}, ${projectId}, ${source}, ${randomUUID()}, ${text},
            ${`[${vecFor(text).join(',')}]`}::vector, now())`);
  return id;
}

const search = (projectId: string, strategy: 'semantic' | 'keyword' | 'hybrid', query = MARKER) =>
  runMemorySearch({ projectId, query, strategy, topK: 10, surface: 'agent' });

describe('flip to chunked: the buried marker becomes findable', () => {
  it('flat misses a marker in the last paragraph; after the flip + reindex the matched chunk is the last one, on semantic and keyword', async () => {
    const { projectId, token } = await project();
    const ref = randomUUID();
    await indexMemory({ projectId, source: 'issue', sourceRef: ref, text: longBody() });

    const flat = await search(projectId, 'semantic');
    const flatHit = flat.hits.find((h) => h.sourceRef === ref);
    expect(flatHit).toBeDefined();
    expect(flatHit?.score ?? 1).toBeLessThan(0.1);
    expect(flatHit?.matchedChunk).toBeUndefined();

    const flip = await post(projectId, token, 'chunked');
    expect(flip.status).toBe(202);
    expect((await flip.json()) as object).toMatchObject({
      model: 'chunked',
      reindex: { state: 'queued', total: 1, done: 0, remaining: 1 },
    });
    expect(sends.map((s) => s.queue)).toEqual([reindexMod.MEMORY_CHUNK_REINDEX_QUEUE]);

    const done = await reindexMod.runChunkReindex(projectId);
    expect(done).toMatchObject({ state: 'completed', total: 1, done: 1, remaining: 0 });
    const row = await rowState(projectId, ref);
    expect(row.chunked_at).not.toBeNull();
    expect(row.chunks.length).toBe(chunkerMod.chunkText(longBody()).length);
    expect(row.chunks.every((c) => c.generation === row.chunk_generation)).toBe(true);

    const sem = await search(projectId, 'semantic');
    const semHit = sem.hits.find((h) => h.sourceRef === ref);
    expect(semHit?.score ?? 0).toBeGreaterThan(0.9);
    expect(semHit?.matchedChunk?.index).toBe(row.chunks.length - 1);
    expect(semHit?.matchedChunk?.text).toContain(MARKER);

    const kw = await search(projectId, 'keyword');
    const kwHit = kw.hits.find((h) => h.sourceRef === ref);
    expect(kwHit?.matchedChunk?.index).toBe(row.chunks.length - 1);

    const get = await app.request(`/api/app-config/${projectId}/memory-model/reindex`, {
      headers: json(token),
    });
    expect(await get.json()).toMatchObject({ model: 'chunked', reindex: { state: 'completed' } });
  });

  it('mid-migration a not-yet-chunked row and a chunked row both answer the same keyword', async () => {
    const { projectId } = await project();
    await setModel(projectId, 'chunked');
    const chunkedRef = randomUUID();
    await indexMemory({
      projectId,
      source: 'note',
      sourceRef: chunkedRef,
      text: `The ${MARKER} note, already chunked.`,
    });
    const flatId = await plantFlat(projectId, 'note', `The ${MARKER} note, still flat.`);
    const res = await search(projectId, 'keyword');
    const ids = res.hits.map((h) => h.id);
    expect(ids).toContain(flatId);
    expect(res.hits.some((h) => h.sourceRef === chunkedRef && h.matchedChunk)).toBe(true);
    expect(res.hits.find((h) => h.id === flatId)?.matchedChunk).toBeUndefined();
  });

  it('the estimate counts only the five chunked sources and sizes chunks by the chunker rule', async () => {
    const { projectId, token } = await project();
    const a = 'a'.repeat(400);
    const b = 'b '.repeat(2000);
    await plantFlat(projectId, 'issue', a);
    await plantFlat(projectId, 'knowledge', b);
    await plantFlat(projectId, 'comment', 'c'.repeat(9000));
    const res = await app.request(`/api/app-config/${projectId}/memory-model/estimate`, {
      headers: json(token),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      memories: 2,
      totalChars: a.length + b.length,
      estimatedChunks: chunkerMod.estimateChunks(a.length) + chunkerMod.estimateChunks(b.length),
      estimatedEmbedCalls: 2,
    });
  });
});

describe('writes on a chunked project', () => {
  it('a chunked-source write publishes chunks in one generation; a comment gets none', async () => {
    const { projectId } = await project();
    await setModel(projectId, 'chunked');
    const noteRef = randomUUID();
    await indexMemory({ projectId, source: 'note', sourceRef: noteRef, text: longBody() });
    const note = await rowState(projectId, noteRef);
    expect(note.chunked_at).not.toBeNull();
    expect(note.chunks.length).toBeGreaterThan(1);
    expect(new Set(note.chunks.map((c) => c.generation))).toEqual(new Set([note.chunk_generation]));

    const commentRef = randomUUID();
    await indexMemory({ projectId, source: 'comment', sourceRef: commentRef, text: longBody() });
    const comment = await rowState(projectId, commentRef);
    expect(comment.chunks).toEqual([]);
    expect(comment.chunked_at).toBeNull();
  });

  it('a rewrite under an outage leaves no stale passage; the backfill completes it once embeddings return', async () => {
    const { projectId } = await project();
    await setModel(projectId, 'chunked');
    const ref = randomUUID();
    await indexMemory({ projectId, source: 'note', sourceRef: ref, text: longBody('oldmarker') });
    const before = await rowState(projectId, ref);
    expect(before.chunks.length).toBeGreaterThan(1);

    fake.outage = true;
    const degraded = await indexMemory({
      projectId,
      source: 'note',
      sourceRef: ref,
      text: longBody(),
    });
    expect(degraded.degraded).toBe(true);
    const during = await rowState(projectId, ref);
    expect(during.chunk_generation).toBe(before.chunk_generation + 1);
    expect(during.chunked_at).toBeNull();
    expect(during.chunks).toEqual([]);
    const stale = await search(projectId, 'keyword', 'oldmarker');
    expect(stale.hits.find((h) => h.sourceRef === ref)).toBeUndefined();

    fake.outage = false;
    await backfillMod.runEmbeddingBackfill();
    await backfillMod.runChunkBackfill();
    const after = await rowState(projectId, ref);
    expect(after.chunked_at).not.toBeNull();
    expect(after.chunks.length).toBeGreaterThan(1);
    expect(after.chunks.every((c) => c.generation === during.chunk_generation)).toBe(true);
    const fresh = await search(projectId, 'semantic');
    expect(fresh.hits.find((h) => h.sourceRef === ref)?.matchedChunk?.text).toContain(MARKER);
  });
});

describe('reindex lifecycle', () => {
  it('409 while live, cancel between batches keeps the finished work, resume completes; a member cannot flip', async () => {
    const { projectId, token } = await project();
    const member = await project('member');
    for (let i = 0; i < reindexMod.REINDEX_BATCH_SIZE + 10; i += 1) {
      await plantFlat(projectId, 'note', `note ${i} ${'x'.repeat(1000)}`);
    }
    expect((await post(projectId, member.token, 'chunked')).status).toBe(403);
    expect((await post(projectId, token, 'chunked')).status).toBe(202);
    expect((await post(projectId, token, 'chunked')).status).toBe(409);

    const firstBatchCalls = reindexMod.REINDEX_BATCH_SIZE;
    fake.onCall = async (n) => {
      if (n === firstBatchCalls) await reindexMod.writeReindex(projectId, { state: 'cancelled' });
    };
    const cancelled = await reindexMod.runChunkReindex(projectId);
    fake.onCall = null;
    expect(cancelled?.state).toBe('cancelled');
    const [counts] = await harness.db.execute<{ chunked: number }>(
      sql`SELECT count(*)::int AS chunked FROM memories WHERE project_id = ${projectId} AND chunked_at IS NOT NULL`,
    );
    expect(counts?.chunked).toBe(reindexMod.REINDEX_BATCH_SIZE);

    expect(
      (
        await app.request(`/api/app-config/${projectId}/memory-model/reindex`, {
          method: 'DELETE',
          headers: json(token),
        })
      ).status,
    ).toBe(409);

    const resume = await post(projectId, token, 'chunked');
    expect(resume.status).toBe(202);
    expect((await resume.json()) as object).toMatchObject({
      reindex: { total: reindexMod.REINDEX_BATCH_SIZE + 10, done: reindexMod.REINDEX_BATCH_SIZE },
    });
    const callsBefore = fake.calls;
    const done = await reindexMod.runChunkReindex(projectId);
    expect(done).toMatchObject({ state: 'completed', remaining: 0 });
    expect(fake.calls - callsBefore).toBe(10);
  });

  it('an outage fails the job with its error; a retry resumes from the rows still unchunked', async () => {
    const { projectId, token } = await project();
    for (let i = 0; i < 4; i += 1) await plantFlat(projectId, 'note', `note ${i}`);
    await post(projectId, token, 'chunked');
    fake.onCall = async (n) => {
      if (n === 3) fake.outage = true;
    };
    const failed = await reindexMod.runChunkReindex(projectId);
    expect(failed).toMatchObject({ state: 'failed', done: 2, remaining: 2 });
    expect(failed?.lastError).toContain('outage');

    fake.onCall = null;
    fake.outage = false;
    expect((await post(projectId, token, 'chunked')).status).toBe(202);
    expect(await reindexMod.runChunkReindex(projectId)).toMatchObject({
      state: 'completed',
      done: 4,
      remaining: 0,
    });
  });

  it('DELETE cancels a queued reindex', async () => {
    const { projectId, token } = await project();
    await plantFlat(projectId, 'note', 'one');
    await post(projectId, token, 'chunked');
    const res = await app.request(`/api/app-config/${projectId}/memory-model/reindex`, {
      method: 'DELETE',
      headers: json(token),
    });
    expect(res.status).toBe(200);
    expect(await reindexMod.readReindex(projectId)).toMatchObject({ state: 'cancelled' });
    expect(await reindexMod.runChunkReindex(projectId)).toMatchObject({ state: 'cancelled' });
  });

  it('revert to flat is immediate, cancels the live reindex, schedules a 7-day purge that only runs while still flat', async () => {
    const { projectId, token } = await project();
    const ref = randomUUID();
    await setModel(projectId, 'chunked');
    await indexMemory({ projectId, source: 'note', sourceRef: ref, text: longBody() });
    await reindexMod.writeReindex(projectId, {
      state: 'running',
      total: 1,
      done: 0,
      remaining: 1,
      requestedAt: new Date().toISOString(),
    });

    const res = await post(projectId, token, 'flat');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ model: 'flat', reindex: { state: 'cancelled' } });
    const purge = sends.find((s) => s.queue === reindexMod.MEMORY_CHUNK_PURGE_QUEUE);
    expect(purge?.opts).toMatchObject({ startAfter: reindexMod.CHUNK_PURGE_DELAY_SECONDS });
    const flatNow = await search(projectId, 'semantic');
    expect(flatNow.hits.find((h) => h.sourceRef === ref)?.matchedChunk).toBeUndefined();

    await setModel(projectId, 'chunked');
    expect(await reindexMod.runChunkPurge(projectId)).toEqual({ purged: false });
    expect((await rowState(projectId, ref)).chunks.length).toBeGreaterThan(1);

    await setModel(projectId, 'flat');
    expect(await reindexMod.runChunkPurge(projectId)).toEqual({ purged: true });
    const purged = await rowState(projectId, ref);
    expect(purged.chunks).toEqual([]);
    expect(purged.chunked_at).toBeNull();
  });

  it('memoryModel is not writable through PUT /api/app-config (400)', async () => {
    const { projectId, token } = await project();
    const res = await app.request(`/api/app-config/${projectId}`, {
      method: 'PUT',
      headers: json(token),
      body: JSON.stringify({ memoryModel: 'chunked' }),
    });
    expect(res.status).toBe(400);
  });
});
