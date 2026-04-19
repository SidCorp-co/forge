import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiClient, ApiError } from '@/lib/api/client';

const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeJwt(exp: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256' }));
  const payload = btoa(JSON.stringify({ exp }));
  return `${header}.${payload}.signature`;
}

describe('apiClient', () => {
  it('sends correct headers and attaches auth token', async () => {
    const token = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    (localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue(token);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: 'ok' }),
    });

    await apiClient('/test');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/test'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        }),
      })
    );
  });

  it('throws ApiError with status on error response', async () => {
    (localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue(null);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    });

    await expect(apiClient('/missing')).rejects.toThrow(ApiError);
    await expect(apiClient('/missing')).rejects.toMatchObject({ status: 404 });
  });

  it('sends request without Authorization header when no token', async () => {
    (localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue(null);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await apiClient('/test');

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('does not attach expired token', async () => {
    const expired = makeJwt(Math.floor(Date.now() / 1000) - 100);
    (localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue(expired);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await apiClient('/test');

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('treats malformed token as expired', async () => {
    (localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue('not-a-jwt');
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await apiClient('/test');

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers).not.toHaveProperty('Authorization');
  });
});
