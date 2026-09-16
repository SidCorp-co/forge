/**
 * ISS-1025 — `listKnowledgeEntries` is one bounded query, trimmed by a running
 * count.
 *
 * It used to fetch every matching row with no `LIMIT`, and then, whenever the
 * result was over the response cap, re-`JSON.stringify` the WHOLE kept array
 * once per row it dropped — quadratic in the payload on exactly the projects
 * big enough to need trimming.
 */

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test' },
}));
vi.mock('../embeddings/index.js', () => ({
  embed: vi.fn(),
  EmbeddingUnavailableError: class extends Error {},
}));

const calls: Array<{ where: unknown; limit: number | null }> = [];
let rows: Array<Record<string, unknown>> = [];
const selects = vi.fn();

function makeChain() {
  selects();
  const state: { where: unknown; limit: number | null } = { where: null, limit: null };
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = (clause: unknown) => {
    state.where = clause;
    return chain;
  };
  chain.orderBy = () => chain;
  chain.limit = (n: number) => {
    state.limit = n;
    calls.push(state);
    return chain;
  };
  (chain as { then: PromiseLike<unknown>['then'] }).then = (resolve, reject) =>
    Promise.resolve(rows.slice(0, state.limit ?? rows.length)).then(resolve, reject);
  return chain;
}

vi.mock('../db/client.js', () => ({ db: { select: () => makeChain() } }));

const { listKnowledgeEntries, MAX_RESPONSE_CHARS, MAX_LIST_ROWS } = await import('./service.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

/** The smallest row this projection can produce, plus the window count column. */
function minimalRow(i: number, total: number) {
  return {
    id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
    slug: 'a',
    kind: 'rule',
    title: 'a',
    injection: 'none',
    confidence: 'inferred',
    authoredBy: 'agent',
    orderIndex: 0,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    total,
  };
}

function wideRow(i: number, total: number, titleChars: number) {
  return { ...minimalRow(i, total), title: 't'.repeat(titleChars) };
}

/** The response as the caller receives it, for measuring against the cap. */
const serialized = (result: { rows: unknown[] }) => JSON.stringify({ rows: result.rows }).length;

beforeEach(() => {
  calls.length = 0;
  selects.mockClear();
  rows = [];
});

describe('listKnowledgeEntries', () => {
  it('runs exactly one query', async () => {
    rows = [minimalRow(0, 1)];
    await listKnowledgeEntries({ projectId: PROJECT_ID });
    expect(selects).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('bounds the fetch with a SQL LIMIT', async () => {
    rows = [minimalRow(0, 1)];
    await listKnowledgeEntries({ projectId: PROJECT_ID });
    expect(calls[0]?.limit).toBe(MAX_LIST_ROWS);
  });

  /**
   * The row cap must never be the reason a row is dropped: `MAX_RESPONSE_CHARS`
   * is the bound the caller was promised, and a SQL `LIMIT` below the number of
   * rows that can fit under it would shorten a response silently. The shortest
   * row this projection can serialise, taken MAX_LIST_ROWS times, has to be
   * longer than the character cap.
   */
  it('caps rows above the largest number that can fit under the character cap', () => {
    const shortestRows = Array.from({ length: MAX_LIST_ROWS }, (_, i) => {
      const { total: _total, ...row } = minimalRow(i, MAX_LIST_ROWS);
      return row;
    });
    expect(JSON.stringify({ rows: shortestRows }).length).toBeGreaterThan(MAX_RESPONSE_CHARS);
  });

  it('reports total as the number of matching entries, not the number fetched', async () => {
    rows = Array.from({ length: 3 }, (_, i) => minimalRow(i, 4242));
    const result = await listKnowledgeEntries({ projectId: PROJECT_ID });
    expect(result.total).toBe(4242);
    expect(result.returned).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it('returns every row untruncated when the result fits under the cap', async () => {
    rows = Array.from({ length: 5 }, (_, i) => minimalRow(i, 5));
    const result = await listKnowledgeEntries({ projectId: PROJECT_ID });
    expect(result.rows).toHaveLength(5);
    expect(result).toMatchObject({ truncated: false, returned: 5, total: 5 });
    expect(result.rows[0]).not.toHaveProperty('total');
  });

  it('trims to the cap and says so', async () => {
    const n = 60;
    rows = Array.from({ length: n }, (_, i) => wideRow(i, n, 1000));
    const result = await listKnowledgeEntries({ projectId: PROJECT_ID });
    expect(serialized(result)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(result.returned).toBeLessThan(n);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(n);
  });

  /**
   * The kept set is the longest prefix that fits: one more row would cross the
   * cap. A trim that stopped early would satisfy the assertion above.
   */
  it('keeps the LONGEST prefix that fits, not merely one that does', async () => {
    const n = 60;
    rows = Array.from({ length: n }, (_, i) => wideRow(i, n, 1000));
    const result = await listKnowledgeEntries({ projectId: PROJECT_ID });
    const oneMore = JSON.stringify({
      rows: [...result.rows, { ...wideRow(result.returned, n, 1000), total: undefined }],
    }).length;
    expect(oneMore).toBeGreaterThan(MAX_RESPONSE_CHARS);
  });

  /**
   * The cap is JavaScript string length over the same serialisation the old
   * whole-array `JSON.stringify` measured — NOT UTF-8 bytes. A title outside
   * the BMP is where the two part company, and byte accounting would drop a
   * row from a response that used to carry it.
   */
  it('measures the cap in string length, so a wide-character title does not shorten the page', async () => {
    const perRow = 900;
    const n = 40;
    rows = Array.from({ length: n }, (_, i) => ({
      ...minimalRow(i, n),
      title: '𝍮'.repeat(perRow / 2),
    }));
    const result = await listKnowledgeEntries({ projectId: PROJECT_ID });
    expect(result.truncated).toBe(true);
    const chars = serialized(result);
    expect(chars).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(Buffer.byteLength(JSON.stringify({ rows: result.rows }), 'utf8')).toBeGreaterThan(
      MAX_RESPONSE_CHARS,
    );
  });

  it('filters on project, kind, injection and archived-at in the query', async () => {
    rows = [minimalRow(0, 1)];
    await listKnowledgeEntries({ projectId: PROJECT_ID, kind: 'rule', injection: 'always' });
    const { sql, params } = new PgDialect().sqlToQuery(calls[0]?.where as SQL);
    expect(params).toContain(PROJECT_ID);
    expect(params).toContain('rule');
    expect(params).toContain('always');
    expect(sql).toMatch(/"archived_at" is null/);
  });

  it('returns an empty page rather than failing when nothing matches', async () => {
    rows = [];
    const result = await listKnowledgeEntries({ projectId: PROJECT_ID });
    expect(result).toEqual({ rows: [], truncated: false, returned: 0, total: 0 });
  });
});
