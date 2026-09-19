import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test' },
}));

class FakeOutage extends Error {}
const embedBatchMock = vi.fn();
vi.mock('../embeddings/index.js', () => ({
  embedBatch: (texts: string[]) => embedBatchMock(texts),
  EmbeddingUnavailableError: FakeOutage,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const inserted: Array<Record<string, unknown>[]> = [];
const conflicts: Array<{ set: Record<string, unknown> }> = [];
let returned: Array<{ id: string; slug: string; projectId: string }> = [];
vi.mock('../db/client.js', () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>[]) => {
        inserted.push(v);
        return {
          onConflictDoUpdate: (cfg: { set: Record<string, unknown> }) => {
            conflicts.push(cfg);
            return { returning: async () => returned };
          },
        };
      },
    }),
  },
}));

const { upsertKnowledgeEntries, upsertKnowledgeEntry, knowledgeEmbedText } = await import(
  './service.js'
);

const PROJECT = '11111111-1111-4111-8111-111111111111';
const dialect = new PgDialect();
/** The SQL text of the `embedding` clause the upsert would send. */
const embeddingClause = () => dialect.sqlToQuery(conflicts[0]?.set.embedding as SQL).sql;

const entry = (slug: string, title: string, body: string) => ({
  projectId: PROJECT,
  slug,
  title,
  body,
  kind: 'guide' as const,
  injection: 'on_demand' as const,
  confidence: 'verified' as const,
  authoredBy: 'human' as const,
  orderIndex: 0,
});

beforeEach(() => {
  inserted.length = 0;
  conflicts.length = 0;
  embedBatchMock.mockReset();
  embedBatchMock.mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2]));
  returned = [];
});

describe('upsertKnowledgeEntries', () => {
  it('embeds every entry of a batch in one call', async () => {
    const entries = [entry('a', 'A', 'body a'), entry('b', 'B', 'body b'), entry('c', 'C', 'c')];
    returned = entries.map((e) => ({ id: `id-${e.slug}`, slug: e.slug, projectId: e.projectId }));

    await upsertKnowledgeEntries(entries);

    expect(embedBatchMock).toHaveBeenCalledTimes(1);
    expect(embedBatchMock.mock.calls[0]?.[0]).toEqual([
      knowledgeEmbedText('A', 'body a'),
      knowledgeEmbedText('B', 'body b'),
      knowledgeEmbedText('C', 'c'),
    ]);
    expect(inserted[0]).toHaveLength(3);
  });

  it('sends the later of two inputs on one slug, and embeds that one only', async () => {
    returned = [{ id: 'id-a', slug: 'a', projectId: PROJECT }];

    const results = await upsertKnowledgeEntries([
      entry('a', 'First title', 'first body'),
      entry('a', 'Second title', 'second body'),
    ]);

    expect(embedBatchMock.mock.calls[0]?.[0]).toEqual([
      knowledgeEmbedText('Second title', 'second body'),
    ]);
    expect(inserted[0]).toHaveLength(1);
    expect(inserted[0]?.[0]).toMatchObject({ title: 'Second title', body: 'second body' });
    expect(results.map((r) => r.id)).toEqual(['id-a', 'id-a']);
  });

  it('preserves a stored vector under an outage only when title AND body are unchanged', async () => {
    embedBatchMock.mockRejectedValueOnce(new FakeOutage('down'));
    returned = [{ id: 'id-a', slug: 'a', projectId: PROJECT }];

    const [result] = await upsertKnowledgeEntries([entry('a', 'A', 'body a')]);

    expect(result?.degraded).toBe(true);
    expect(inserted[0]?.[0]).toMatchObject({ embedding: null });
    const clause = embeddingClause();
    expect(clause).toContain('"body" = excluded.body');
    expect(clause).toContain('"title" = excluded.title');
  });

  it('overwrites the stored vector outright when the embed succeeded', async () => {
    returned = [{ id: 'id-a', slug: 'a', projectId: PROJECT }];
    await upsertKnowledgeEntries([entry('a', 'A', 'body a')]);
    expect(embeddingClause()).toBe('excluded.embedding');
  });

  it('refuses a batch the embeddings service answered short', async () => {
    embedBatchMock.mockResolvedValueOnce([[0.1, 0.2]]);
    await expect(
      upsertKnowledgeEntries([entry('a', 'A', 'a'), entry('b', 'B', 'b')]),
    ).rejects.toThrow('returned 1 vectors for 2 texts');
    expect(inserted).toHaveLength(0);
  });

  it('answers an empty batch without touching the embeddings service', async () => {
    expect(await upsertKnowledgeEntries([])).toEqual([]);
    expect(embedBatchMock).not.toHaveBeenCalled();
  });

  it('keeps both entries when two projects send the same slug', async () => {
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const mine = entry('deploy-guide', 'Mine', 'my body');
    const theirs = { ...entry('deploy-guide', 'Theirs', 'their body'), projectId: OTHER };
    returned = [
      { id: 'id-mine', slug: 'deploy-guide', projectId: PROJECT },
      { id: 'id-theirs', slug: 'deploy-guide', projectId: OTHER },
    ];

    const results = await upsertKnowledgeEntries([mine, theirs]);

    expect(inserted[0]).toHaveLength(2);
    expect(embedBatchMock.mock.calls[0]?.[0]).toEqual([
      knowledgeEmbedText('Mine', 'my body'),
      knowledgeEmbedText('Theirs', 'their body'),
    ]);
    expect(results.map((r) => r.id)).toEqual(['id-mine', 'id-theirs']);
  });

  it('upsertKnowledgeEntry is the batch of one', async () => {
    returned = [{ id: 'id-a', slug: 'a', projectId: PROJECT }];
    const result = await upsertKnowledgeEntry(entry('a', 'A', 'body a'));
    expect(result).toMatchObject({ id: 'id-a', slug: 'a', degraded: false, truncated: false });
    expect(embedBatchMock).toHaveBeenCalledTimes(1);
    expect(inserted[0]).toHaveLength(1);
  });
});
