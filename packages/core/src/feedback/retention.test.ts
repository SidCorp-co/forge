import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  due: [] as { id: string }[],
  paths: [] as { path: string }[],
  wheres: [] as unknown[],
  embeddingsDeleted: [] as string[],
  storageDeleted: [] as string[],
}));

vi.mock('../db/client.js', () => {
  const chain = () => ({
    from: () => ({
      where: (w: unknown) => {
        state.wheres.push(w);
        return { limit: async () => state.due };
      },
    }),
  });
  const tx = {
    select: chain,
    delete: () => ({ where: () => ({ returning: async () => state.paths }) }),
  };
  return { db: { transaction: async (body: (t: unknown) => unknown) => body(tx) } };
});
vi.mock('../knowledge/index.js', () => ({
  deleteFeedbackEmbedding: async (_tx: unknown, id: string) => {
    state.embeddingsDeleted.push(id);
  },
}));
vi.mock('../integrations/index.js', () => ({
  getStorage: () => ({
    delete: async (path: string) => {
      state.storageDeleted.push(path);
    },
  }),
}));

const { sweepDeclinedFeedback, DECLINED_PURGE_AFTER_DAYS } = await import('./retention.js');

describe('feedback-lifecycle declined: attachments and embedding go after 180 days', () => {
  beforeEach(() => {
    state.due = [];
    state.paths = [];
    state.wheres = [];
    state.embeddingsDeleted = [];
    state.storageDeleted = [];
  });

  it('is 180 days', () => {
    expect(DECLINED_PURGE_AFTER_DAYS).toBe(180);
  });

  it('selects declined items whose decline is older than the window', async () => {
    const now = new Date('2026-10-05T00:00:00Z');
    await sweepDeclinedFeedback(now);
    const dialect = new PgDialect();
    const parts = state.wheres.map((w) => dialect.sqlToQuery(w as SQL));
    const q = { sql: parts.map((p) => p.sql).join(' | '), params: parts.flatMap((p) => p.params) };
    const outer = parts.at(-1);
    expect(outer?.sql).toMatch(/^\("feedback"\."status" = \$1 and /);
    expect(outer?.params[0]).toBe('declined');
    expect(q.sql).toContain('"feedback_decisions"."decided_at" < ');
    const cutoff = q.params.find((p) => typeof p === 'string' && /^\d{4}-/.test(p));
    expect(cutoff).toBe(new Date('2026-04-08T00:00:00.000Z').toISOString());
    expect(q.sql).toContain('"feedback_attachments"');
    expect(q.sql).toContain('"item_embeddings"');
  });

  it('removes the attachments with their bytes and the embedding of every due item', async () => {
    state.due = [{ id: 'f1' }, { id: 'f2' }];
    state.paths = [{ path: 'feedback/p/f1/a.png' }];
    const r = await sweepDeclinedFeedback();
    expect(r).toEqual({ items: 2, attachments: 1 });
    expect(state.embeddingsDeleted).toEqual(['f1', 'f2']);
    expect(state.storageDeleted).toEqual(['feedback/p/f1/a.png']);
  });

  it('touches nothing when no declined item is due', async () => {
    const r = await sweepDeclinedFeedback();
    expect(r).toEqual({ items: 0, attachments: 0 });
    expect(state.embeddingsDeleted).toEqual([]);
    expect(state.storageDeleted).toEqual([]);
  });
});
