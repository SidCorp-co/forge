import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Pair = {
  binding: { id: string; provider: string; label: string; config: Record<string, unknown> };
  connection: { id: string; config: Record<string, unknown>; secretsEnc: Buffer | null };
};

const bound = vi.hoisted(() => new Map<string, Pair[]>());
const secretsByConnection = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock('../../integrations/store.js', () => ({
  listActiveBindingsForProjectProvider: async (_projectId: string, provider: string) =>
    bound.get(provider) ?? [],
  effectiveConfig: (pair: Pair) => ({ ...pair.connection.config, ...pair.binding.config }),
  decryptConnectionSecrets: (connection: Pair['connection']) =>
    secretsByConnection.get(connection.id) ?? {},
  findConnectionById: async () => null,
  updateConnection: async () => undefined,
}));

vi.mock('../../integrations/mcp-preview-service.js', () => ({
  buildMcpPreview: async () => ({ servers: [] }),
}));

vi.mock('./lib.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib.js')>()),
  resolveEffectiveProjectId: async () => '11111111-1111-4111-8111-111111111111',
  assertPrincipalIsMember: async () => undefined,
}));

const { registerAllIntegrations } = await import('../../integrations/register-all.js');
const { forgeStorefrontTargetTool } = await import('./forge-storefront-target.js');

const TOKEN = 'sat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function autoflowPair(): Pair {
  secretsByConnection.set('c-auto', { accessToken: TOKEN });
  return {
    binding: { id: 'b-auto', provider: 'autoflow', label: '', config: { shop: 'hop' } },
    connection: {
      id: 'c-auto',
      config: { storeId: '42', storeSlug: 'hop', storeName: 'HOP' },
      secretsEnc: null,
    },
  };
}

function epodPair(): Pair {
  return {
    binding: { id: 'b-epod', provider: 'epodsystem', label: '', config: {} },
    connection: { id: 'c-epod', config: { storeSlug: 'shop-a' }, secretsEnc: null },
  };
}

const call = (args: Record<string, unknown> = {}) =>
  forgeStorefrontTargetTool({ principal: {} } as never).handler(args) as Promise<
    Record<string, unknown>
  >;

beforeEach(() => {
  registerAllIntegrations();
  bound.clear();
  secretsByConnection.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('forge_storefront_target serves every storefront provider (ISS-51)', () => {
  it('answers an autoflow binding with its site and the flows read live, never the token', async () => {
    bound.set('autoflow', [autoflowPair()]);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      return new Response(
        JSON.stringify({
          data: {
            backendWorkflows: [
              { code: 'admit', name: 'Admit patient', version: 3, published_at: null },
            ],
            backendRoutes: [
              { method: 'POST', path: '/admit', workflow_code: 'admit', is_published: false },
            ],
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await call();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://auto.sidcorp.co/graphql');
    expect(out).toMatchObject({
      configured: true,
      provider: 'autoflow',
      shop: 'hop',
      storeId: '42',
      siteUrl: 'https://hop.auto.sidcorp.co',
      mcpUrl: 'https://mcp.auto.sidcorp.co/mcp',
      backendResolvedLive: true,
      workflows: [{ code: 'admit', name: 'Admit patient', version: 3, publishedAt: null }],
      routes: [{ method: 'POST', path: '/admit', workflow: 'admit', published: false }],
    });
    expect((out.shopTools as { backendRelease: string[] }).backendRelease).toContain(
      'revert_backend_workflow',
    );
    expect(JSON.stringify(out)).not.toContain('sat_');
  });

  it('says the flows are UNKNOWN, and why, when the live read fails', async () => {
    bound.set('autoflow', [autoflowPair()]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 502 })),
    );
    const out = await call();
    expect(out).toMatchObject({
      configured: true,
      backendResolvedLive: false,
      workflows: null,
      routes: null,
      backendUnresolvedBecause: 'http_502',
    });
    expect(out.note).toMatch(/binding facts only/);
  });

  it('refuses by name to guess between two bound storefront providers', async () => {
    bound.set('autoflow', [autoflowPair()]);
    bound.set('epodsystem', [epodPair()]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    await expect(call()).rejects.toThrow(/^STOREFRONT_PROVIDER_AMBIGUOUS: .*pass provider/);
    const epod = await call({ provider: 'epodsystem' });
    expect(epod).toMatchObject({
      configured: true,
      provider: 'epodsystem',
      storeSlug: 'shop-a',
      themesResolvedLive: false,
    });
  });

  it('refuses a provider that is not a storefront provider, naming the ones that are', async () => {
    await expect(call({ provider: 'coolify' })).rejects.toThrow(
      /^STOREFRONT_PROVIDER_UNKNOWN: "coolify" .*epodsystem, autoflow/,
    );
  });

  it('answers configured:false when nothing storefront-shaped is bound', async () => {
    expect(await call()).toEqual({ configured: false });
  });
});
