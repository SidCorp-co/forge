import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateConnectionMock = vi.fn();
const findConnectionByIdMock = vi.fn();
vi.mock('../store.js', () => ({
  updateConnection: (...a: unknown[]) => updateConnectionMock(...(a as [])),
  findConnectionById: (...a: unknown[]) => findConnectionByIdMock(...(a as [])),
}));

const { epodsystemAdapter } = await import('./adapter.js');

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const CONN_ID = 'conn-ep-1';
const BINDING_ID = 'bind-ep-1';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
  updateConnectionMock.mockReset();
  findConnectionByIdMock.mockReset();
});

beforeEach(() => {
  updateConnectionMock.mockResolvedValue({});
  findConnectionByIdMock.mockResolvedValue({ id: CONN_ID, config: {} });
});

function buildCtx(secrets: Record<string, unknown>) {
  return {
    projectId: PROJECT_ID,
    connectionId: CONN_ID,
    bindingId: BINDING_ID,
    config: { environment: 'prod' },
    secrets,
    // biome-ignore lint/suspicious/noExplicitAny: adapter ctx generics resolved at registration
  } as any;
}

const apiKeyContextOk = {
  data: {
    apiKeyContext: {
      organization_id: 'org-1',
      scopes: ['*'],
      stores: [{ id: 'store-1', slug: 's', name: 'Store', active_theme_id: 'theme-1' }],
    },
  },
};

const apiKeyContextErrors = {
  errors: [{ message: 'invalid api key' }],
};

describe('epodsystemAdapter.healthcheck — rotation-window fallback (ISS-405)', () => {
  it('retries with previousApiKey on HTTP 401 within the rotation window', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization ?? '';
      calls.push(auth);
      if (auth === 'Bearer crmk_current') return new Response('unauthorized', { status: 401 });
      // Enrichment probe (second call after the retry) returns empty body.
      const text = init?.body ? String(init.body) : '';
      if (text.includes('storeThemes')) {
        return new Response(JSON.stringify({ data: { storeThemes: [], storeDomains: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(apiKeyContextOk), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await epodsystemAdapter.healthcheck(
      buildCtx({
        apiKey: 'crmk_current',
        previousApiKey: 'crmk_previous',
        previousTokenExpiresAt: future,
      }),
    );

    expect(res.status).toBe('ok');
    expect(calls[0]).toBe('Bearer crmk_current');
    expect(calls[1]).toBe('Bearer crmk_previous');
    expect(calls[2]).toBe('Bearer crmk_previous');
    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'ok' }),
    );
  });

  it('retries with previousApiKey on a 200 + GraphQL errors[] auth rejection', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization ?? '';
      calls.push(auth);
      const text = init?.body ? String(init.body) : '';
      if (text.includes('storeThemes')) {
        return new Response(JSON.stringify({ data: { storeThemes: [], storeDomains: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (auth === 'Bearer crmk_current') {
        return new Response(JSON.stringify(apiKeyContextErrors), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(apiKeyContextOk), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await epodsystemAdapter.healthcheck(
      buildCtx({
        apiKey: 'crmk_current',
        previousApiKey: 'crmk_previous',
        previousTokenExpiresAt: future,
      }),
    );

    expect(res.status).toBe('ok');
    expect(calls.slice(0, 2)).toEqual(['Bearer crmk_current', 'Bearer crmk_previous']);
  });

  it('does NOT retry when the rotation window has expired', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push((init?.headers as Record<string, string>).Authorization ?? '');
      return new Response('unauthorized', { status: 401 });
    }) as unknown as typeof fetch;

    const past = new Date(Date.now() - 60_000).toISOString();
    const res = await epodsystemAdapter.healthcheck(
      buildCtx({
        apiKey: 'crmk_current',
        previousApiKey: 'crmk_previous',
        previousTokenExpiresAt: past,
      }),
    );

    expect(calls).toEqual(['Bearer crmk_current']);
    // Key rejected (HTTP 401) and the rotation window expired → needs_reauth (ISS-409).
    expect(res.status).toBe('needs_reauth');
    expect(res.message).toBe('invalid Epodsystem API key');
    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'needs_reauth' }),
    );
  });

  it('does NOT retry when no previousApiKey is stored', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push((init?.headers as Record<string, string>).Authorization ?? '');
      return new Response(JSON.stringify(apiKeyContextErrors), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const res = await epodsystemAdapter.healthcheck(buildCtx({ apiKey: 'crmk_current' }));

    expect(calls).toEqual(['Bearer crmk_current']);
    // 200 + GraphQL errors[] auth rejection, no previous key → needs_reauth (ISS-409).
    expect(res.status).toBe('needs_reauth');
    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'needs_reauth' }),
    );
  });
});

describe('what the healthcheck may write back onto a shared connection', () => {
  function healthyFetch() {
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const text = init?.body ? String(init.body) : '';
      if (text.includes('storeThemes')) {
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }
      return new Response(JSON.stringify(apiKeyContextOk), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it('writes the resolved store identity and none of the binding tier keys', async () => {
    healthyFetch();
    findConnectionByIdMock.mockResolvedValue({ id: CONN_ID, config: { orgId: 'org-0' } });
    const ctx = buildCtx({ apiKey: 'crmk_current' });
    ctx.config = {
      environment: 'prod',
      releaseRunnerLabel: 'project-a-box',
      verify: { probes: [{ url: 'https://a.example/version' }] },
      rollback: 'project A says redeploy the previous tag',
    };

    const result = await epodsystemAdapter.healthcheck(ctx);

    expect(result.status).toBe('ok');
    const written = updateConnectionMock.mock.calls[0]?.[1] as {
      config: Record<string, unknown>;
    };
    expect(written.config.orgId).toBe('org-1');
    expect(written.config.storeSlug).toBe('s');
    expect(written.config.releaseRunnerLabel).toBeUndefined();
    expect(written.config.verify).toBeUndefined();
    expect(written.config.rollback).toBeUndefined();
  });

  it('keeps a connection-tier key the probes did not resolve', async () => {
    healthyFetch();
    findConnectionByIdMock.mockResolvedValue({
      id: CONN_ID,
      config: { orgId: 'org-0', domain: 'kept.example' },
    });
    const ctx = buildCtx({ apiKey: 'crmk_current' });

    await epodsystemAdapter.healthcheck(ctx);

    const written = updateConnectionMock.mock.calls[0]?.[1] as {
      config: Record<string, unknown>;
    };
    expect(written.config.domain).toBe('kept.example');
  });
});
