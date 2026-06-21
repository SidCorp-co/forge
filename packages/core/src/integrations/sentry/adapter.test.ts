import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateConnectionMock = vi.fn();
vi.mock('../store.js', () => ({
  updateConnection: (...a: unknown[]) => updateConnectionMock(...(a as [])),
}));

const { sentryAdapter } = await import('./adapter.js');

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const CONN_ID = 'conn-sentry-1';
const BINDING_ID = 'bind-sentry-1';

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
    config: { host: 'logs.canawan.com', environment: 'prod' },
    secrets,
    // biome-ignore lint/suspicious/noExplicitAny: adapter ctx generics resolved at registration
  } as any;
}

describe('sentryAdapter.healthcheck', () => {
  it('returns status:ok with org diagnostics when the token is valid', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('https://logs.canawan.com/api/0/organizations/');
      return new Response(JSON.stringify([{ id: 1, slug: 'canawan', name: 'Canawan' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.healthcheck(buildCtx({ authToken: 'sntryu_valid' }));
    expect(res.status).toBe('ok');
    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'ok' }),
    );
    // Diagnostics surface only non-secret identity — never the token.
    expect(JSON.stringify(res.diagnostics)).not.toContain('sntryu_valid');
  });

  it('retries with previousAuthToken on 401 within the rotation window (ISS-405)', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization ?? '';
      calls.push(auth);
      if (auth === 'Bearer sntryu_current') return new Response('nope', { status: 401 });
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await sentryAdapter.healthcheck(
      buildCtx({
        authToken: 'sntryu_current',
        previousAuthToken: 'sntryu_previous',
        previousTokenExpiresAt: future,
      }),
    );

    expect(calls).toEqual(['Bearer sntryu_current', 'Bearer sntryu_previous']);
    expect(res.status).toBe('ok');
  });

  it('returns needs_reauth when the token is rejected and no rotation window applies', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 401 }),
    ) as unknown as typeof fetch;

    const res = await sentryAdapter.healthcheck(buildCtx({ authToken: 'sntryu_bad' }));
    expect(res.status).toBe('needs_reauth');
    expect(res.message).toBe('invalid Sentry auth token');
    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'needs_reauth' }),
    );
  });

  it('surfaces non-401 HTTP errors without retrying', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push((init?.headers as Record<string, string>).Authorization ?? '');
      return new Response('boom', { status: 500 });
    }) as unknown as typeof fetch;

    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await sentryAdapter.healthcheck(
      buildCtx({
        authToken: 'sntryu_current',
        previousAuthToken: 'sntryu_previous',
        previousTokenExpiresAt: future,
      }),
    );

    expect(calls).toEqual(['Bearer sntryu_current']);
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/HTTP 500/);
  });

  it('errors when no auth token is configured', async () => {
    const res = await sentryAdapter.healthcheck(buildCtx({}));
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/no Sentry auth token/);
  });
});
