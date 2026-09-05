import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const DIM = 1536;
function hotVector(hotIdx: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[hotIdx] = 1;
  return v;
}

let harness: TestDatabase;
let projectId: string;
let embeddingsMod: typeof import('../../src/embeddings/index.js');
let backfill: typeof import('../../src/memory/embedding-backfill.js');

function stubEmbedding(impl: () => Promise<number[]>) {
  const fake = {
    embed: vi.fn(impl),
    embedBatch: vi.fn(async () => [await impl()]),
    resetBreaker: () => undefined,
  };
  embeddingsMod.resetEmbeddingsClient(
    fake as unknown as InstanceType<
      typeof import('../../src/embeddings/index.js').EmbeddingsClient
    >,
  );
  return fake;
}

async function nullEmbeddedEntry(slug: string): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO knowledge_entries (project_id, kind, slug, title, body)
    VALUES (${projectId}::uuid, 'convention', ${slug}, ${`Title ${slug}`}, 'Written while the embeddings service was down.')`);
}

async function embeddedCount(): Promise<number> {
  const rows = (await harness.db.execute(
    sql`SELECT count(*)::int AS n FROM knowledge_entries WHERE project_id = ${projectId}::uuid AND embedding IS NOT NULL`,
  )) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

describe('the embedding backfill sweeps knowledge entries too (ISS-907, extra fix)', () => {
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
    embeddingsMod = await import('../../src/embeddings/index.js');
    backfill = await import('../../src/memory/embedding-backfill.js');
    await truncateAll(harness.db);
    const user = await createTestUser(harness.db);
    projectId = (await createTestProject(harness.db, user.id)).id;
  }, 120_000);

  afterAll(async () => {
    await harness.cleanup();
  });

  it('re-embeds a knowledge entry stored with embedding = NULL, from the same text the upsert embeds', async () => {
    await nullEmbeddedEntry(`degraded-${randomUUID().slice(0, 8)}`);
    await harness.db.execute(sql`
      INSERT INTO memories (project_id, source, source_ref, text_content, metadata)
      VALUES (${projectId}::uuid, 'note', ${randomUUID()}, 'a memory row written degraded too', '{}'::jsonb)`);
    expect(await embeddedCount()).toBe(0);
    const fake = stubEmbedding(async () => hotVector(3));

    const result = await backfill.runEmbeddingBackfill();

    expect(result).toMatchObject({ reembedded: 1, knowledgeReembedded: 1, aborted: false });
    expect(await embeddedCount()).toBe(1);
    const sent = fake.embed.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(
      sent.some((t) => t.startsWith('Title degraded-') && t.includes('\n\nWritten while')),
    ).toBe(true);
  });

  it('a second sweep finds nothing to do and never overwrites a vector', async () => {
    const fake = stubEmbedding(async () => hotVector(4));
    const result = await backfill.runEmbeddingBackfill();
    expect(result).toMatchObject({ reembedded: 0, knowledgeReembedded: 0, aborted: false });
    expect(fake.embed).not.toHaveBeenCalled();
  });

  it('an embeddings outage aborts the knowledge sweep and leaves the row for the next tick', async () => {
    await nullEmbeddedEntry(`outage-${randomUUID().slice(0, 8)}`);
    stubEmbedding(async () => {
      throw new embeddingsMod.EmbeddingUnavailableError('down');
    });
    const result = await backfill.runEmbeddingBackfill();
    expect(result.aborted).toBe(true);
    expect(result.knowledgeReembedded).toBe(0);
    expect(await embeddedCount()).toBe(1);
  });
});
