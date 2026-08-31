/**
 * ISS-889 §2 — the "is this list complete?" contract, on the REST side.
 *
 * MCP answers it in the body (`hasMore`, `truncated`), which cannot go missing
 * without the parse failing. REST answers it in a header, which can: a route
 * that forgets `setTotalCount`, or a CORS config that stops exposing the name,
 * both produce a response that parses perfectly and lies about its own size.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth-api', () => ({ getAccessToken: () => 'test-token' }));

const { apiClientList } = await import('./client');

const fetchMock = vi.fn();

function listResponse(items: unknown[], headers: Record<string, string>): Response {
  return new Response(JSON.stringify(items), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiClientList — a page cannot pass for a whole list', () => {
  it('reports the header count, not the page length', async () => {
    fetchMock.mockResolvedValueOnce(listResponse([{ id: 1 }, { id: 2 }], { 'X-Total-Count': '900' }));

    await expect(apiClientList<{ id: number }>('/things')).resolves.toEqual({
      items: [{ id: 1 }, { id: 2 }],
      totalCount: 900,
    });
  });

  // cm:guard this is the case the old `header !== null ? … : items.length` fallback answered WRONG and silently. Restore that fallback and this test is the only thing that goes red — every other list assertion in the app keeps passing, because a truncated page and a complete list are byte-identical once the header is gone.
  it('throws when the header is absent, instead of guessing the page is the whole list', async () => {
    fetchMock.mockResolvedValueOnce(listResponse([{ id: 1 }, { id: 2 }], {}));

    await expect(apiClientList('/things')).rejects.toThrow(/X-Total-Count/);
  });

  it('throws on a header that is not a number', async () => {
    fetchMock.mockResolvedValueOnce(listResponse([{ id: 1 }], { 'X-Total-Count': 'lots' }));

    await expect(apiClientList('/things')).rejects.toThrow(/not a number/);
  });

  it('treats 204 as a complete empty list, header or not', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(apiClientList('/things')).resolves.toEqual({ items: [], totalCount: 0 });
  });
});
