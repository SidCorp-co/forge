import { describe, expect, it } from 'vitest';
import { buildListEnvelope, overfetch } from './list-envelope.js';

const row = (i: number) => ({ id: i, title: `row ${i}` });
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i));

describe('overfetch', () => {
  it('asks for exactly one row past the limit', () => {
    expect(overfetch(25)).toBe(26);
    expect(overfetch(1)).toBe(2);
  });
});

describe('buildListEnvelope', () => {
  it('states hasMore:false on a complete result — the honest signal ISS-787 was missing', () => {
    const result = buildListEnvelope({ key: 'issues', items: rows(3), limit: 25, hint: 'filter' });
    expect(result).toEqual({ issues: rows(3), returned: 3, limit: 25, hasMore: false });
  });

  it('reports hasMore even when the result exactly fills the limit', () => {
    const complete = buildListEnvelope({ key: 'issues', items: rows(10), limit: 10, hint: 'f' });
    expect(complete.hasMore).toBe(false);
    expect(complete.truncated).toBeUndefined();

    const partial = buildListEnvelope({ key: 'issues', items: rows(11), limit: 10, hint: 'f' });
    expect(partial.hasMore).toBe(true);
    expect(partial.returned).toBe(10);
    expect((partial.issues as unknown[]).length).toBe(10);
  });

  it('never returns the overfetched probe row to the caller', () => {
    const result = buildListEnvelope({ key: 'jobs', items: rows(26), limit: 25, hint: 'f' });
    expect((result.jobs as Array<{ id: number }>).at(-1)?.id).toBe(24);
  });

  it('names the limit as the cause when only the limit bound the result', () => {
    const result = buildListEnvelope({
      key: 'issues',
      items: rows(11),
      limit: 10,
      hint: 'add filters',
    });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('limit');
    expect(result.notice).toContain('limit of 10');
    expect(result.notice).toContain('Raise limit');
  });

  it('says a higher limit will not help when the response-size cap bound it', () => {
    const fat = Array.from({ length: 5 }, (_, i) => ({ id: i, blob: 'x'.repeat(2_000) }));
    const result = buildListEnvelope({
      key: 'issues',
      items: fat,
      limit: 25,
      hint: 'add status filters',
      maxChars: 4_000,
    });
    expect(result.truncatedBy).toBe('response-size');
    expect(result.notice).toContain('will NOT help');
    expect(JSON.stringify({ issues: result.issues }).length).toBeLessThanOrEqual(4_000);
  });

  it('reports both caps when both bit', () => {
    const fat = Array.from({ length: 11 }, (_, i) => ({ id: i, blob: 'x'.repeat(2_000) }));
    const result = buildListEnvelope({
      key: 'issues',
      items: fat,
      limit: 10,
      hint: 'add status filters',
      maxChars: 4_000,
    });
    expect(result.truncatedBy).toBe('limit+response-size');
    expect(result.hasMore).toBe(true);
  });

  it('states no number the caller cannot verify — no fabricated total', () => {
    const result = buildListEnvelope({ key: 'issues', items: rows(11), limit: 10, hint: 'f' });
    expect(result.notice).not.toContain('of 11');
    expect(Object.keys(result)).not.toContain('total');
  });

  it('sheds the head for an ascending list so the newest rows survive', () => {
    const fat = Array.from({ length: 5 }, (_, i) => ({ id: i, blob: 'x'.repeat(2_000) }));
    const result = buildListEnvelope({
      key: 'comments',
      items: fat,
      limit: 25,
      hint: 'read it in the UI',
      order: 'asc',
      maxChars: 4_000,
    });
    expect((result.comments as Array<{ id: number }>).at(-1)?.id).toBe(4);
  });

  it('keeps the one row that alone exceeds the response-size cap', () => {
    // cm:guard ISS-956 — this used to return ZERO rows, and under a cursor an empty page is a dead end: nothing to resume from and no progress made. A single 20K-character agent report over the whole budget is ordinary, not pathological, so the one row survives and the response is deliberately over `maxChars`.
    const huge = [{ id: 0, blob: 'x'.repeat(50_000) }];
    const result = buildListEnvelope({
      key: 'issues',
      items: huge,
      limit: 25,
      hint: 'f',
      maxChars: 100,
    });
    expect(result).toMatchObject({ issues: huge, returned: 1, hasMore: false });
    expect('truncated' in result).toBe(false);
  });

  it('still sheds every row but one when the budget cannot hold them', () => {
    const fat = Array.from({ length: 4 }, (_, i) => ({ id: i, blob: 'x'.repeat(200) }));
    const result = buildListEnvelope({
      key: 'issues',
      items: fat,
      limit: 25,
      hint: 'f',
      maxChars: 100,
    });
    expect(result.returned).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('response-size');
  });
});

describe('buildListEnvelope notice — an oldest-first list is not described as newest-first', () => {
  it('says "the first N in order" when the limit bound an ascending list', () => {
    const res = buildListEnvelope({
      key: 'comments',
      items: [1, 2, 3],
      limit: 2,
      hint: 'read the thread in the UI',
      order: 'asc',
    });

    expect(res.notice).toContain('the first 2 in order');
    expect(res.notice).not.toContain('most recent');
  });

  it('keeps "most recent" for the default newest-first list', () => {
    const res = buildListEnvelope({
      key: 'issues',
      items: [1, 2, 3],
      limit: 2,
      hint: 'add filters',
    });

    expect(res.notice).toContain('the 2 most recent');
  });

  it('names both ends when an ascending list hit the limit and then the size cap', () => {
    const res = buildListEnvelope({
      key: 'comments',
      items: [{ body: 'x'.repeat(400) }, { body: 'y'.repeat(400) }, { body: 'z'.repeat(400) }],
      limit: 2,
      hint: 'read the thread in the UI',
      order: 'asc',
      maxChars: 500,
    });

    expect(res.truncatedBy).toBe('limit+response-size');
    expect(res.notice).toContain('bound this to the first 2');
    expect(res.notice).toContain('most recent of them');
  });
});

describe('buildListEnvelope cursor (ISS-956)', () => {
  const of = (item: { id: number }) => `cursor-${item.id}`;

  it('carries nextCursor:null and hasMore:false when the query found no more', () => {
    const result = buildListEnvelope({
      key: 'comments',
      items: rows(3),
      limit: 50,
      hint: 'h',
      order: 'asc',
      sizeTrimSheds: 'newest',
      cursor: { more: false, of },
    });
    expect(result.nextCursor).toBeNull();
    expect(result.hasMore).toBe(false);
  });

  it('offers the last row as the cursor when the query found more', () => {
    const result = buildListEnvelope({
      key: 'comments',
      items: rows(3),
      limit: 50,
      hint: 'h',
      order: 'asc',
      sizeTrimSheds: 'newest',
      cursor: { more: true, of },
    });
    expect(result.nextCursor).toBe('cursor-2');
    expect(result.hasMore).toBe(true);
  });

  it('does not call a page followed by another page "truncated"', () => {
    const result = buildListEnvelope({
      key: 'comments',
      items: rows(3),
      limit: 50,
      hint: 'h',
      order: 'asc',
      sizeTrimSheds: 'newest',
      cursor: { more: true, of },
    });
    expect(result.truncated).toBeUndefined();
    expect(result.notice).toBeUndefined();
  });

  it('mints the cursor from the last row the size trim KEPT, not the last fetched', () => {
    const fat = Array.from({ length: 6 }, (_, i) => ({ id: i, blob: 'x'.repeat(200) }));
    const result = buildListEnvelope({
      key: 'comments',
      items: fat,
      limit: 50,
      hint: 'h',
      order: 'asc',
      sizeTrimSheds: 'newest',
      cursor: { more: false, of },
      maxChars: 700,
    });
    const kept = result.comments as Array<{ id: number }>;
    expect(kept.length).toBeLessThan(6);
    expect(result.nextCursor).toBe(`cursor-${kept.at(-1)?.id}`);
    expect(result.hasMore).toBe(true);
  });

  it('sheds the NEWEST rows under a cursor, so the walk never steps over one', () => {
    const fat = Array.from({ length: 6 }, (_, i) => ({ id: i, blob: 'x'.repeat(200) }));
    const result = buildListEnvelope({
      key: 'comments',
      items: fat,
      limit: 50,
      hint: 'h',
      order: 'asc',
      sizeTrimSheds: 'newest',
      cursor: { more: false, of },
      maxChars: 700,
    });
    expect((result.comments as Array<{ id: number }>)[0]?.id).toBe(0);
  });

  it('offers the cursor as the remedy in the notice rather than "read it in the UI"', () => {
    const fat = Array.from({ length: 6 }, (_, i) => ({ id: i, blob: 'x'.repeat(200) }));
    const result = buildListEnvelope({
      key: 'comments',
      items: fat,
      limit: 50,
      hint: 'read the full thread in the UI',
      order: 'asc',
      sizeTrimSheds: 'newest',
      cursor: { more: false, of },
      maxChars: 700,
    });
    expect(result.notice).toContain('nextCursor');
    expect(result.notice).not.toContain('will NOT help');
  });

  it('leaves a non-cursor surface exactly as it was — no nextCursor key at all', () => {
    const result = buildListEnvelope({ key: 'issues', items: rows(11), limit: 10, hint: 'f' });
    expect('nextCursor' in result).toBe(false);
    expect(result.hasMore).toBe(true);
  });
});
