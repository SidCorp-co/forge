import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  agentPath: new Map<string, string>(),
  orgRole: null as string | null,
  inbound: new Map<string, string | null>(),
  onCreated: vi.fn(async () => ({ repoUrl: 'https://github.com/acme/shop' })),
  notified: vi.fn(),
  broadcast: vi.fn(),
  verify: vi.fn(async () => [
    {
      code: 'COOLIFY_APPLICATION_UNKNOWN',
      path: '/applications/0/resourceUuid',
      detail: 'unknown',
    },
  ]),
}));

vi.mock('../integrations/registry.js', () => ({
  getIntegration: (provider: string) =>
    h.agentPath.has(provider)
      ? {
          capabilities: {
            agentPath: { kind: h.agentPath.get(provider) },
            multiBinding: provider === 'epodsystem',
          },
        }
      : undefined,
  getAdapter: (provider: string) => ({
    inboundSecret: h.inbound.has(provider) ? () => h.inbound.get(provider) : undefined,
    onBindingCreated: provider === 'github' ? h.onCreated : undefined,
    verifyBindingTarget: provider === 'coolify' ? h.verify : undefined,
  }),
}));
vi.mock('../integrations/store.js', () => ({
  findConnectionById: async (id: string) => ({ id, provider: id.split(':')[0] }),
  findBindingWithConnectionById: async (id: string) => ({ binding: { id } }),
}));
vi.mock('../integrations/route-helpers.js', () => ({
  notifyConnectionChanged: h.notified,
  broadcastIntegrationChanged: h.broadcast,
  runInitialHealthcheck: async () => ({ status: 'ok' }),
}));
vi.mock('../lib/authz.js', () => ({
  effectiveProjectRole: async () => (h.orgRole ? { orgRole: h.orgRole } : null),
  orgRoleAtLeast: (role: string | null, min: string) =>
    role === 'owner' || (role === 'admin' && min === 'admin'),
}));

const { bindEffects } = await import('./bind-effects.js');

const ask = (provider: string, agentAccess: 'none' | 'all', label = '') =>
  bindEffects.refusals({ userId: 'u', projectId: 'p', provider, label, agentAccess });

beforeEach(() => {
  h.agentPath.clear();
  h.inbound.clear();
  h.orgRole = null;
  h.onCreated.mockClear();
  h.notified.mockClear();
  h.broadcast.mockClear();
});

describe('what a binding write refuses', () => {
  it('refuses an agent grant on a provider with no agent path', async () => {
    h.agentPath.set('postman', 'none');
    expect(await ask('postman', 'all')).toEqual([
      expect.objectContaining({ code: 'AGENT_ACCESS_UNSUPPORTED', path: '/agentAccess' }),
    ]);
    expect(await ask('postman', 'none')).toEqual([]);
  });

  it('takes an org admin to grant a credential that reaches a runner box', async () => {
    h.agentPath.set('github', 'direct-mcp');
    h.orgRole = 'member';
    expect(await ask('github', 'all')).toEqual([
      expect.objectContaining({ code: 'AGENT_ACCESS_NEEDS_ORG_ADMIN' }),
    ]);
    h.orgRole = 'admin';
    expect(await ask('github', 'all')).toEqual([]);
  });

  it('refuses a label on a provider that holds one binding per project', async () => {
    h.agentPath.set('sentry', 'core-mediated');
    h.agentPath.set('epodsystem', 'core-mediated');
    expect(await ask('sentry', 'none', 'second')).toEqual([
      expect.objectContaining({ code: 'BINDING_LABEL_UNSUPPORTED', path: '/target/label' }),
    ]);
    expect(await ask('epodsystem', 'none', 'shop-eu')).toEqual([]);
  });

  it('lets a project admin grant a core-mediated provider', async () => {
    h.agentPath.set('sentry', 'core-mediated');
    expect(await ask('sentry', 'all')).toEqual([]);
  });
});

describe('the effects of a write', () => {
  it("mints the provider's own inbound secret, or a random one where it has none", async () => {
    h.inbound.set('github', 'whsec_app');
    expect(await bindEffects.inboundSecret('github:1')).toBe('whsec_app');
    expect(await bindEffects.inboundSecret('sentry:1')).toMatch(/^whsec_[0-9a-f]{48}$/);
  });

  it("runs the provider's bind effect on a create only, and notifies the connection on every write", async () => {
    const write = {
      bindingId: 'b1',
      projectId: 'p',
      connectionId: 'github:1',
      provider: 'github',
      role: 'service' as const,
      config: { owner: 'acme', repo: 'shop', installationId: 1 },
    };
    expect(await bindEffects.afterWrite({ ...write, created: true })).toEqual({
      repoUrl: 'https://github.com/acme/shop',
      health: { status: 'ok' },
    });
    expect(await bindEffects.afterWrite({ ...write, created: false })).toEqual({});
    expect(h.onCreated).toHaveBeenCalledTimes(1);
    expect(h.notified).toHaveBeenCalledTimes(2);
    expect(h.broadcast).toHaveBeenCalledWith('p', { bindingId: 'b1', connectionId: 'github:1' });
  });
});

describe('asking the provider about a target', () => {
  it("prefixes the provider's refusal with the target, and asks a provider with no check nothing", async () => {
    const ask = (provider: string) =>
      bindEffects.targetRefusals({
        projectId: 'p',
        connectionId: `${provider}:1`,
        provider,
        config: { targets: [] },
        held: null,
      });
    expect(await ask('coolify')).toEqual([
      expect.objectContaining({ path: '/target/applications/0/resourceUuid' }),
    ]);
    expect(await ask('sentry')).toEqual([]);
    expect(h.verify).toHaveBeenCalledTimes(1);
  });
});
