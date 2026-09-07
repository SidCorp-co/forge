/**
 * ISS-956 — the issue-detail screen renders the WHOLE thread, so its client
 * walks every page. A first page rendered as the thread is a silent truncation
 * and the screen has no control that would let a reader ask for the rest.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth-api', () => ({ getAccessToken: () => 'test-token' }));

const { apiClientCursorAll } = await import('./client');

const fetchMock = vi.fn();

function page(items: unknown[], total: number, nextCursor: string | null): Response {
  return new Response(JSON.stringify({ items, returned: items.length, total, limit: 2, nextCursor, hasMore: nextCursor !== null }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiClientCursorAll — the whole thread, not its first page', () => {
  it('concatenates every page and reports the envelope total', async () => {
    fetchMock.mockResolvedValueOnce(page([{ id: 1 }, { id: 2 }], 5, 'c2'));
    fetchMock.mockResolvedValueOnce(page([{ id: 3 }, { id: 4 }], 5, 'c4'));
    fetchMock.mockResolvedValueOnce(page([{ id: 5 }], 5, null));

    await expect(apiClientCursorAll<{ id: number }>('/issues/x/comments')).resolves.toEqual({
      items: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
      totalCount: 5,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('sends the cursor it was handed, url-encoded, on every page after the first', async () => {
    fetchMock.mockResolvedValueOnce(page([{ id: 1 }], 2, 'a+b/c=='));
    fetchMock.mockResolvedValueOnce(page([{ id: 2 }], 2, null));

    await apiClientCursorAll('/issues/x/comments');

    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('cursor=');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('cursor=a%2Bb%2Fc%3D%3D');
  });

  // cm:guard the walk must stop on `nextCursor === null` and on nothing else. A `total` that outruns the rows is NORMAL here — the comments route counts replies in `total` while a page carries roots — so a stop derived from `items.length < total` reads the end of the thread as a missing page and never terminates.
  it('stops on a null cursor even while total still exceeds what it has', async () => {
    fetchMock.mockResolvedValueOnce(page([{ id: 1 }], 900, null));

    await expect(apiClientCursorAll('/issues/x/comments')).resolves.toEqual({
      items: [{ id: 1 }],
      totalCount: 900,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('appends the cursor with & when the endpoint already carries a query', async () => {
    fetchMock.mockResolvedValueOnce(page([{ id: 1 }], 2, 'tok'));
    fetchMock.mockResolvedValueOnce(page([{ id: 2 }], 2, null));

    await apiClientCursorAll('/issues/x/comments?format=html');

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('?format=html&cursor=tok');
  });

  it('treats 204 as a complete empty thread', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(apiClientCursorAll('/issues/x/comments')).resolves.toEqual({
      items: [],
      totalCount: 0,
    });
  });

  // cm:guard a server that always returns a cursor must make this THROW, never spin. The loop is the only thing between a contract break on the route and a browser tab that hangs with no error anyone can read.
  it('throws rather than spinning when the cursor never goes null', async () => {
    fetchMock.mockImplementation(async () => page([{ id: 1 }], 900, 'always'));

    await expect(apiClientCursorAll('/issues/x/comments')).rejects.toThrow(/still returning a cursor/);
  });
});
