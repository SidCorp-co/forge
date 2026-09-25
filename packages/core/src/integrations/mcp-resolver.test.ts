import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BindingWithConnection } from './store.js';

const listAgentGrantedBindings = vi.fn(
  async (_projectId: string, _provider: string) => [] as BindingWithConnection[],
);
const decryptConnectionSecrets = vi.fn((): unknown => ({ apiKey: 'crmk_live' }));

vi.mock('./agent-access-store.js', () => ({ listAgentGrantedBindings }));
vi.mock('./store.js', async (original) => ({
  ...(await original<typeof import('./store.js')>()),
  decryptConnectionSecrets,
}));

(await import('./register-all.js')).registerAllIntegrations();

const { applyGrantedMcpServers } = await import('./mcp-resolver.js');

const PROJECT = 'p-1';

/** An epodsystem binding: the one direct-mcp provider that declares `multiBinding`. */
function epodPair(id: string, label: string) {
  return {
    binding: {
      id,
      projectId: PROJECT,
      provider: 'epodsystem',
      role: 'service',
      stages: null,
      label,
      config: { storeSlug: 'acme', storeName: 'Acme' },
      active: true,
      agentAccess: 'all',
      integrationSecret: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    connection: {
      id: `c-${id}`,
      provider: 'epodsystem',
      config: { storeSlug: 'acme', storeName: 'Acme' },
      active: true,
      secretsEnc: 'enc',
      lastHealthStatus: 'ok',
      lastHealthAt: new Date(0),
      breakerOpenedAt: null,
    },
  } as unknown as BindingWithConnection;
}

beforeEach(() => {
  vi.clearAllMocks();
  decryptConnectionSecrets.mockReturnValue({ apiKey: 'crmk_live' });
  listAgentGrantedBindings.mockResolvedValue([]);
});

describe('applyGrantedMcpServers — one claim per server name (ISS-1191)', () => {
  it('keeps the first granted binding to claim a name, and names it as the holder', async () => {
    // `mcpServerNameFor` maps `-` to `_`, so these two labels are one server name. Overwriting
    // meant the newer binding displaced the one an agent was already being served, and the
    // displaced one read downstream as a credential that would not decrypt.
    const first = epodPair('b-first', 'north-shop');
    const second = epodPair('b-second', 'north_shop');
    listAgentGrantedBindings.mockImplementation(async (_p: string, provider: string) =>
      provider === 'epodsystem' ? [first, second] : [],
    );

    const out = await applyGrantedMcpServers(PROJECT, null);

    expect(out.produced).toEqual([{ name: 'epodsystem_north_shop', bindingId: 'b-first' }]);
    expect(Object.keys(out.map ?? {})).toEqual(['epodsystem_north_shop']);
  });

  it('gives two granted bindings under distinct names one entry each', async () => {
    const north = epodPair('b-north', 'north-shop');
    const south = epodPair('b-south', 'south-shop');
    listAgentGrantedBindings.mockImplementation(async (_p: string, provider: string) =>
      provider === 'epodsystem' ? [north, south] : [],
    );

    const out = await applyGrantedMcpServers(PROJECT, null);

    expect(out.produced).toEqual([
      { name: 'epodsystem_north_shop', bindingId: 'b-north' },
      { name: 'epodsystem_south_shop', bindingId: 'b-south' },
    ]);
  });

  it('produces nothing, and keeps the map it was given, for a credential that will not decrypt', async () => {
    listAgentGrantedBindings.mockImplementation(async (_p: string, provider: string) =>
      provider === 'epodsystem' ? [epodPair('b-first', 'north-shop')] : [],
    );
    decryptConnectionSecrets.mockImplementation(() => {
      throw new Error('bad key');
    });

    const out = await applyGrantedMcpServers(PROJECT, { playwright: {} });

    expect(out.produced).toEqual([]);
    expect(out.map).toEqual({ playwright: {} });
  });
});
