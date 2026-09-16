// ISS-1024 against a real Postgres: what the write path does NOT re-embed, and what the row is
// left holding when the pre-read the skip decided on turns out to have been overtaken.
//
// The fake embeddings client counts its calls, so "no work was done" is measured rather than
// inferred, and its vector depends on the first 2,000 characters of what it embeds — the same
// fake the chunked e2e uses, for the same reason.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

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
const HEAD_CHARS = 2000;

/** Outage switch and call counter for the fake embeddings client. */
const fake = { outage: false, calls: 0, onCall: null as null | ((n: number) => Promise<void>) };

function vecFor(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[text.slice(0, HEAD_CHARS).includes(MARKER) ? 7 : 0] = 1;
  return v;
}

let harness: TestDatabase;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let indexMemory: typeof import('../../src/memory/indexer.js').indexMemory;
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

  const [idx, ch, jwtMod] = await Promise.all([
    import('../../src/memory/indexer.js'),
    import('../../src/memory/chunker.js'),
    import('../../src/auth/jwt.js'),
  ]);
  indexMemory = idx.indexMemory;
  chunkerMod = ch;
  signUserToken = jwtMod.signUserToken;
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

describe('a write that changes nothing is not re-embedded or re-chunked', () => {
  async function chunkRows(projectId: string, sourceRef: string) {
    const [m] = await harness.db.execute<{ id: string }>(
      sql`SELECT id FROM memories WHERE project_id = ${projectId} AND source_ref = ${sourceRef}`,
    );
    if (!m) throw new Error('memory row missing');
    const rows = await harness.db.execute<{
      id: string;
      chunk_index: number;
      text_content: string;
      context_prefix: string;
      generation: number;
      has_vector: boolean;
    }>(
      sql`SELECT id, chunk_index, text_content, context_prefix, generation,
                 (embedding IS NOT NULL) AS has_vector
            FROM memory_chunks WHERE memory_id = ${m.id} ORDER BY chunk_index`,
    );
    return { memoryId: m.id, rows: [...rows] };
  }

  const vectorOf = async (projectId: string, sourceRef: string) => {
    const [row] = await harness.db.execute<{ embedding: string | null; text_content: string }>(
      sql`SELECT embedding::text AS embedding, text_content FROM memories
           WHERE project_id = ${projectId} AND source_ref = ${sourceRef}`,
    );
    return row;
  };

  it('a flat re-write of identical text makes no embed call and keeps the vector it had', async () => {
    const { projectId } = await project();
    const ref = randomUUID();
    await indexMemory({ projectId, source: 'note', sourceRef: ref, text: 'the runner claims' });
    const before = await vectorOf(projectId, ref);
    fake.calls = 0;

    const result = await indexMemory({
      projectId,
      source: 'note',
      sourceRef: ref,
      text: 'the runner claims',
    });

    expect(fake.calls).toBe(0);
    expect(result.degraded).toBe(false);
    expect((await vectorOf(projectId, ref))?.embedding).toBe(before?.embedding);
  });

  it('a flat re-write of changed text does embed, and replaces the vector', async () => {
    const { projectId } = await project();
    const ref = randomUUID();
    await indexMemory({ projectId, source: 'note', sourceRef: ref, text: `plain ${MARKER} here` });
    const before = await vectorOf(projectId, ref);
    fake.calls = 0;

    await indexMemory({ projectId, source: 'note', sourceRef: ref, text: 'nothing of the sort' });

    expect(fake.calls).toBe(1);
    expect((await vectorOf(projectId, ref))?.embedding).not.toBe(before?.embedding);
  });

  it('a row left without a vector by an outage is embedded on the next identical write', async () => {
    const { projectId } = await project();
    const ref = randomUUID();
    fake.outage = true;
    const degraded = await indexMemory({ projectId, source: 'note', sourceRef: ref, text: 'same' });
    expect(degraded.degraded).toBe(true);
    expect((await vectorOf(projectId, ref))?.embedding).toBeNull();

    fake.outage = false;
    fake.calls = 0;
    await indexMemory({ projectId, source: 'note', sourceRef: ref, text: 'same' });

    expect(fake.calls).toBe(1);
    expect((await vectorOf(projectId, ref))?.embedding).not.toBeNull();
  });

  it('a chunked re-write of identical text and metadata leaves the generation and every chunk row alone', async () => {
    const { projectId } = await project();
    const ref = randomUUID();
    await setModel(projectId, 'chunked');
    const body = longBody();
    await indexMemory({ projectId, source: 'note', sourceRef: ref, text: body });
    const before = await chunkRows(projectId, ref);
    expect(before.rows.length).toBeGreaterThan(1);
    const stateBefore = await rowState(projectId, ref);
    fake.calls = 0;

    await indexMemory({ projectId, source: 'note', sourceRef: ref, text: body });

    expect(fake.calls).toBe(0);
    const after = await chunkRows(projectId, ref);
    expect(after.rows.map((r) => r.id)).toEqual(before.rows.map((r) => r.id));
    expect((await rowState(projectId, ref)).chunk_generation).toBe(stateBefore.chunk_generation);
  });

  it('a chunked re-write whose metadata moves the context prefix rebuilds the set', async () => {
    const { projectId } = await project();
    const ref = randomUUID();
    await setModel(projectId, 'chunked');
    const body = longBody();
    await indexMemory({
      projectId,
      source: 'knowledge',
      sourceRef: ref,
      text: body,
      metadata: { category: 'deploy' },
    });
    const before = await chunkRows(projectId, ref);
    expect(before.rows[0]?.context_prefix).toContain('(deploy)');
    fake.calls = 0;

    await indexMemory({
      projectId,
      source: 'knowledge',
      sourceRef: ref,
      text: body,
      metadata: { category: 'retrieval' },
    });

    expect(fake.calls).toBeGreaterThan(0);
    const after = await chunkRows(projectId, ref);
    expect(after.rows[0]?.context_prefix).toContain('(retrieval)');
    expect(after.rows[0]?.generation).toBeGreaterThan(before.rows[0]?.generation as number);
    expect(after.rows.every((r) => r.has_vector)).toBe(true);
  });

  it('a chunked parent whose set was emptied builds one again on the next identical write', async () => {
    const { projectId } = await project();
    const ref = randomUUID();
    await setModel(projectId, 'chunked');
    const body = longBody();
    await indexMemory({ projectId, source: 'note', sourceRef: ref, text: body });
    const { memoryId } = await chunkRows(projectId, ref);
    await harness.db.execute(sql`DELETE FROM memory_chunks WHERE memory_id = ${memoryId}`);
    await harness.db.execute(sql`UPDATE memories SET chunked_at = NULL WHERE id = ${memoryId}`);
    fake.calls = 0;

    await indexMemory({ projectId, source: 'note', sourceRef: ref, text: body });

    expect(fake.calls).toBeGreaterThan(0);
    const after = await chunkRows(projectId, ref);
    expect(after.rows.length).toBeGreaterThan(1);
    expect(after.rows.every((r) => r.has_vector)).toBe(true);
  });

  it('a chunked set holding a chunk with no vector is rebuilt on the next identical write', async () => {
    const { projectId } = await project();
    const ref = randomUUID();
    await setModel(projectId, 'chunked');
    const body = longBody();
    await indexMemory({ projectId, source: 'note', sourceRef: ref, text: body });
    const { memoryId, rows } = await chunkRows(projectId, ref);
    await harness.db.execute(
      sql`UPDATE memory_chunks SET embedding = NULL
           WHERE memory_id = ${memoryId} AND chunk_index = ${rows.length - 1}`,
    );
    fake.calls = 0;

    await indexMemory({ projectId, source: 'note', sourceRef: ref, text: body });

    expect(fake.calls).toBeGreaterThan(0);
    expect((await chunkRows(projectId, ref)).rows.every((r) => r.has_vector)).toBe(true);
  });

  it('a chunked set whose stored passages are not what chunkText produces now is rebuilt', async () => {
    const { projectId } = await project();
    const ref = randomUUID();
    await setModel(projectId, 'chunked');
    const body = longBody();
    await indexMemory({ projectId, source: 'note', sourceRef: ref, text: body });
    const { memoryId } = await chunkRows(projectId, ref);
    await harness.db.execute(
      sql`UPDATE memory_chunks SET text_content = text_content || ' (from an older chunker)'
           WHERE memory_id = ${memoryId} AND chunk_index = 0`,
    );
    fake.calls = 0;

    await indexMemory({ projectId, source: 'note', sourceRef: ref, text: body });

    expect(fake.calls).toBeGreaterThan(0);
    const after = await chunkRows(projectId, ref);
    expect(after.rows[0]?.text_content).not.toContain('older chunker');
    expect(after.rows.map((r) => r.text_content)).toEqual(chunkerMod.chunkText(body.trim()));
    expect(after.rows.every((r) => r.has_vector)).toBe(true);
  });
});

describe('the preserve clause refuses a vector for text the row did not keep', () => {
  const rowOf = (projectId: string, ref: string) =>
    harness.db
      .execute<{ text_content: string; embedding: string | null }>(
        sql`SELECT text_content, embedding::text AS embedding FROM memories
             WHERE project_id = ${projectId} AND source_ref = ${ref}`,
      )
      .then((r) => r[0]);

  it('nulls the vector when the row it lands on carries text this write did not read', async () => {
    const { projectId } = await project();
    const ref = randomUUID();
    await indexMemory({ projectId, source: 'note', sourceRef: ref, text: `first ${MARKER}` });
    await harness.db.execute(
      sql`UPDATE memories SET text_content = 'somebody else entirely'
           WHERE project_id = ${projectId} AND source_ref = ${ref}`,
    );

    fake.outage = true;
    const result = await indexMemory({
      projectId,
      source: 'note',
      sourceRef: ref,
      text: `second ${MARKER}`,
    });
    fake.outage = false;

    expect(result.degraded).toBe(true);
    const row = await rowOf(projectId, ref);
    expect(row?.text_content).toBe(`second ${MARKER}`);
    expect(row?.embedding).toBeNull();
  });
});
