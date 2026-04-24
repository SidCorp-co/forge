import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient, apiClientList } from '@/lib/api/client';

const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiClient', () => {
  it('sends credentials:include and Content-Type when a body is present', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve({ data: 'ok' }),
    });

    await apiClient('/test', { method: 'POST', body: JSON.stringify({ a: 1 }) });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/test'),
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('omits Content-Type for GET requests (no body)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve({}),
    });

    await apiClient('/test');

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers).not.toHaveProperty('Content-Type');
  });

  it('returns undefined on 204 No Content', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      json: () => Promise.reject(new Error('should not be called')),
    });

    const result = await apiClient('/test');
    expect(result).toBeUndefined();
  });

  it('throws ApiError carrying status + code + details from a JSON error body', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers(),
      json: () =>
        Promise.resolve({
          message: 'issue not found',
          code: 'NOT_FOUND',
          details: { id: 'abc' },
        }),
    });

    await expect(apiClient('/missing')).rejects.toThrow(ApiError);
    await expect(apiClient('/missing')).rejects.toMatchObject({
      status: 404,
      message: 'issue not found',
      code: 'NOT_FOUND',
      details: { id: 'abc' },
    });
  });

  it('falls back to statusText when the error body is not JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers(),
      json: () => Promise.reject(new Error('not json')),
    });

    await expect(apiClient('/boom')).rejects.toMatchObject({
      status: 500,
      message: 'Internal Server Error',
    });
  });
});

describe('apiClientList', () => {
  it('reads X-Total-Count and wraps the array into { items, totalCount }', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'X-Total-Count': '42' }),
      json: () => Promise.resolve([{ id: '1' }, { id: '2' }]),
    });

    const res = await apiClientList<{ id: string }>('/issues');
    expect(res.items).toHaveLength(2);
    expect(res.totalCount).toBe(42);
  });

  it('falls back to items.length when X-Total-Count is missing', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve([{ id: '1' }]),
    });

    const res = await apiClientList<{ id: string }>('/issues');
    expect(res.totalCount).toBe(1);
  });
});
