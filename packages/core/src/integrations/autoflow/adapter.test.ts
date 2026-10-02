import { afterEach, describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../store.js', () => ({
  findConnectionById: async () => ({ config: { baseUrl: 'https://auto.example.test' } }),
  updateConnection: async (_id: string, patch: Record<string, unknown>) => {
    writes.push(patch);
  },
}));

const { autoflowIntegration } = await import('./adapter.js');
const adapter = autoflowIntegration.adapter;
if (!adapter) throw new Error('autoflow declares no adapter');

const ctx = (config: Record<string, unknown>, secrets: Record<string, unknown>) =>
  ({
    connectionId: 'c1',
    bindingId: 'b1',
    projectId: 'p1',
    provider: 'autoflow',
    role: 'source',
    config,
    secrets,
    integrationSecret: null,
  }) as Parameters<typeof adapter.healthcheck>[0];

const contextAnswer = (stores: unknown[]) =>
  vi.fn(
    async () =>
      new Response(
        JSON.stringify({ data: { apiKeyContext: { organization_id: 'org-1', stores } } }),
        {
          status: 200,
        },
      ),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  writes.length = 0;
});

describe('autoflow healthcheck', () => {
  it('resolves the one site the token was minted for and records it', async () => {
    vi.stubGlobal(
      'fetch',
      contextAnswer([
        { id: 42, slug: 'hop', name: 'HOP', commerce_enabled: false, active_theme_id: 7 },
      ]),
    );
    const out = await adapter.healthcheck(
      ctx({ baseUrl: 'https://auto.example.test', shop: 'hop' }, { accessToken: 'sat_x' }),
    );
    expect(out).toMatchObject({ status: 'ok', message: 'Connected to HOP' });
    expect(writes.at(-1)).toMatchObject({
      lastHealthStatus: 'ok',
      config: {
        baseUrl: 'https://auto.example.test',
        orgId: 'org-1',
        storeId: '42',
        storeSlug: 'hop',
      },
    });
  });

  it('refuses a token minted for another site than the binding names, naming both', async () => {
    vi.stubGlobal('fetch', contextAnswer([{ id: 9, slug: 'other-shop', name: 'Other' }]));
    const out = await adapter.healthcheck(ctx({ shop: 'hop' }, { accessToken: 'sat_x' }));
    expect(out.status).toBe('needs_reauth');
    expect(out.message).toContain('minted for site "other-shop"');
    expect(out.message).toContain('names shop "hop"');
  });

  it('reads a 200 + UNAUTHENTICATED GraphQL error as needs_reauth with the 12-hour lifetime said', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              errors: [{ message: 'nope', extensions: { code: 'UNAUTHENTICATED' } }],
            }),
            { status: 200 },
          ),
      ),
    );
    const out = await adapter.healthcheck(ctx({ shop: 'hop' }, { accessToken: 'sat_x' }));
    expect(out.status).toBe('needs_reauth');
    expect(out.message).toMatch(/lives 12 hours/);
  });

  it('refuses a token that resolves to no site', async () => {
    vi.stubGlobal('fetch', contextAnswer([]));
    const out = await adapter.healthcheck(ctx({ shop: 'hop' }, { accessToken: 'sat_x' }));
    expect(out.status).toBe('needs_reauth');
    expect(out.message).toContain('resolves to 0 sites');
  });
});

describe('autoflow declaration', () => {
  it('refuses inbound by name', async () => {
    await expect(
      adapter.handleInbound(ctx({}, {}), { headers: {}, rawBody: '', payload: {} }),
    ).rejects.toThrow(/autoflow: handleInbound is not supported/);
  });

  it('renders the shop MCP entry with the bearer, and nothing without a token', () => {
    const path = autoflowIntegration.capabilities.agentPath;
    if (path.kind !== 'direct-mcp') throw new Error('autoflow is not direct-mcp');
    expect(path.buildEntry({ shop: 'hop' }, { accessToken: 'sat_x' })).toEqual({
      type: 'http',
      url: 'https://mcp.auto.sidcorp.co/mcp',
      headers: { Authorization: 'Bearer sat_x' },
      enabled: true,
    });
    expect(
      path.buildEntry({ mcpUrl: 'https://mcp.example.test/mcp/' }, { accessToken: 'sat_x' }),
    ).toMatchObject({ url: 'https://mcp.example.test/mcp' });
    expect(path.buildEntry({}, {})).toBeNull();
  });

  it('refuses a credential the shop MCP door would not admit, by what it is', () => {
    const parsed = autoflowIntegration.schemas.secrets.safeParse({ accessToken: 'wmk_abc' });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('sat_');
  });

  it('refuses a binding with no shop, naming the field', () => {
    const parsed = autoflowIntegration.schemas.bindingConfig.safeParse({});
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['shop']);
    expect(autoflowIntegration.schemas.connectionConfig.safeParse({}).success).toBe(true);
  });
});
