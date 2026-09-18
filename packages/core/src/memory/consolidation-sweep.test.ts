/**
 * ISS-1021 criterion 29 — `runConsolidationSweep` discovers its projects from `projects`.
 *
 * Its own file rather than a block in `consolidation.test.ts`, which is already over its frozen
 * size budget, and because the assertion needs a db stub that RECORDS its builder arguments while
 * that file's stub deliberately swallows them.
 *
 * `runConsolidationSweep` had no test at all — it appears exactly twice in the tree, at its
 * definition and at its queue call site — so the DISTINCT scan over `memories` it replaced could
 * have come back and nothing would have said so. Found while re-judging the criteria on
 * 2026-09-18.
 *
 * What the criterion is about is WHICH TABLE the sweep reads, so the assertion reads the table off
 * the drizzle object the builder was handed, not off this file's imports.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Every builder call the sweep made, in order — method name and its argument. */
const chainCalls = vi.hoisted(() => [] as Array<{ method: string; arg: unknown }>);
const selectResults = vi.hoisted(() => [] as unknown[][]);

vi.mock('../db/client.js', () => {
  const nextResult = () => Promise.resolve(selectResults.shift() ?? []);
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where', 'orderBy']) {
      c[m] = (arg: unknown) => {
        chainCalls.push({ method: m, arg });
        return c;
      };
    }
    c.limit = () => nextResult();
    c.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      nextResult().then(resolve, reject);
    return c;
  };
  return { db: { select: () => chain(), selectDistinct: () => chain() } };
});

// cm:edge contract -> packages/core/src/memory/consolidation.test.ts — these five stubs exist only
// because `consolidation.ts` validates its environment and opens its queue at import time; that
// file owns the behaviour each of them stands in for.
vi.mock('../config/env.js', () => ({
  env: { OPENAI_API_KEY: 'test-key', NODE_ENV: 'test' },
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../queue/boss.js', () => ({
  boss: { send: vi.fn(), createQueue: vi.fn(), work: vi.fn() },
}));
vi.mock('./indexer.js', () => ({
  indexMemory: vi.fn(),
  indexMemoryBestEffort: vi.fn(),
}));
vi.mock('../embeddings/index.js', () => ({
  embed: vi.fn(),
  EmbeddingUnavailableError: class extends Error {},
}));
vi.mock('./search.js', () => ({ searchMemories: vi.fn() }));
vi.mock('../knowledge/search.js', () => ({ searchKnowledge: vi.fn() }));
vi.mock('./feedback-service.js', () => ({ runMemoryFeedback: vi.fn() }));
vi.mock('../issues/issue-prefix-read.js', async () => ({
  formatIssueRef: (prefix: string | null, seq: number | null) => `${prefix ?? 'ISS'}-${seq ?? 0}`,
}));

const { runConsolidationSweep } = await import('./consolidation.js');

describe('runConsolidationSweep discovers its projects from `projects` (ISS-1021)', () => {
  beforeEach(() => {
    chainCalls.length = 0;
    selectResults.length = 0;
  });

  it('reads the `projects` table, and asks about memories only through an EXISTS', async () => {
    selectResults.push([]);

    await runConsolidationSweep();

    const from = chainCalls.find((c) => c.method === 'from');
    // Drizzle carries a table's name on a symbol-keyed property; read it rather than comparing
    // object identity against an import, so this asserts about the SQL and not about this file.
    const table = Object.getOwnPropertySymbols((from?.arg ?? {}) as object)
      .map((symbol) => ((from?.arg ?? {}) as Record<symbol, unknown>)[symbol])
      .find((value) => typeof value === 'string');
    expect(table).toBe('projects');

    const where = chainCalls.find((c) => c.method === 'where');
    const text = JSON.stringify(where?.arg).replace(/\\n/g, ' ').replace(/\s+/g, ' ');
    expect(text).toMatch(/EXISTS \( SELECT 1 FROM memories m/);
    // The candidate set must stay the one the distinct scan produced — a project with nothing
    // consolidatable is still skipped — so both narrowing terms belong inside the EXISTS.
    expect(text).toMatch(/m\.archived_at IS NULL/);
    expect(text).toMatch(/m\.source IN/);
    // And never the shape it replaced.
    expect(text).not.toMatch(/DISTINCT/i);
  });
});
