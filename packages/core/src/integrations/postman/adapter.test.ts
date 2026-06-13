import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateConnectionMock = vi.fn();
vi.mock('../store.js', () => ({
  updateConnection: (...a: unknown[]) => updateConnectionMock(...(a as [])),
}));

const { postmanAdapter } = await import('./adapter.js');

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const CONN_ID = 'conn-pm-1';
const BINDING_ID = 'bind-pm-1';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
  updateConnectionMock.mockReset();
});

beforeEach(() => {
  updateConnectionMock.mockResolvedValue({});
});

function buildCtx(secrets: Record<string, unknown>) {
  return {
    projectId: PROJECT_ID,
    connectionId: CONN_ID,
    bindingId: BINDING_ID,
    config: { workspaceName: 'W', region: 'us', mode: 'minimal', environment: 'prod' },
    secrets,
    // biome-ignore lint/suspicious/noExplicitAny: adapter ctx generics resolved at registration
  } as any;
}

describe('postmanAdapter.healthcheck — rotation-window 401 fallback (ISS-405)', () => {
  it('retries with previousApiKey on 401 within the rotation window and returns status:ok', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const key = (init?.headers as Record<string, string>)['X-Api-Key'] ?? '';
      calls.push(key);
      if (key === 'PMAK-current') return new Response('unauthorized', { status: 401 });
      return new Response(JSON.stringify({ user: { username: 'rotated-ok' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await postmanAdapter.healthcheck(
      buildCtx({
        apiKey: 'PMAK-current',
        previousApiKey: 'PMAK-previous',
        previousTokenExpiresAt: future,
      }),
    );

    expect(calls).toEqual(['PMAK-current', 'PMAK-previous']);
    expect(res.status).toBe('ok');
    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'ok' }),
    );
  });

  it('does NOT retry when the previousTokenExpiresAt window has expired', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push((init?.headers as Record<string, string>)['X-Api-Key'] ?? '');
      return new Response('unauthorized', { status: 401 });
    }) as unknown as typeof fetch;

    const past = new Date(Date.now() - 60_000).toISOString();
    const res = await postmanAdapter.healthcheck(
      buildCtx({
        apiKey: 'PMAK-current',
        previousApiKey: 'PMAK-previous',
        previousTokenExpiresAt: past,
      }),
    );

    expect(calls).toEqual(['PMAK-current']);
    // Key rejected and the rotation window expired → needs_reauth (ISS-409).
    expect(res.status).toBe('needs_reauth');
    expect(res.message).toBe('invalid Postman API key');
    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'needs_reauth' }),
    );
  });

  it('does NOT retry when no previousApiKey is stored', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push((init?.headers as Record<string, string>)['X-Api-Key'] ?? '');
      return new Response('unauthorized', { status: 401 });
    }) as unknown as typeof fetch;

    const res = await postmanAdapter.healthcheck(buildCtx({ apiKey: 'PMAK-current' }));

    expect(calls).toEqual(['PMAK-current']);
    // No previous key to fall back to → credential rejected → needs_reauth (ISS-409).
    expect(res.status).toBe('needs_reauth');
    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'needs_reauth' }),
    );
  });

  it('surfaces non-401 HTTP errors without retrying', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push((init?.headers as Record<string, string>)['X-Api-Key'] ?? '');
      return new Response('boom', { status: 500 });
    }) as unknown as typeof fetch;

    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await postmanAdapter.healthcheck(
      buildCtx({
        apiKey: 'PMAK-current',
        previousApiKey: 'PMAK-previous',
        previousTokenExpiresAt: future,
      }),
    );

    expect(calls).toEqual(['PMAK-current']);
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/HTTP 500/);
  });
});
