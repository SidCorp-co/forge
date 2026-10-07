import { beforeEach, describe, expect, it, vi } from 'vitest';

const P = '00000000-0000-4000-8000-0000000000aa';

let repository: string | null = null;
let environments = new Map<string, { name: string; trigger: string }>();
let pairs: unknown[] = [];

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => Object.assign([], { limit: async () => [{ id: P }] }) }),
    }),
  },
}));

vi.mock('../project-config/index.js', async (orig) => ({
  ...(await orig<typeof import('../project-config/index.js')>()),
  readDeclaredSource: async () => ({ repository, defaultBranch: 'dev', setup: null }),
  readDeployMap: async () => ({ productionBinding: null, environments }),
}));

vi.mock('../integrations/index.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/index.js')>()),
  listBindingsForProject: async () => pairs,
}));

const { registerAllIntegrations } = await import('../integration-registry.js');
registerAllIntegrations();
const { buildIntegrationsStatusCards } = await import('./status-service.js');

function pair(opts: {
  id: string;
  provider: string;
  role?: string;
  config?: Record<string, unknown>;
  connectionConfig?: Record<string, unknown>;
  lastHealthStatus?: string | null;
  active?: boolean;
}) {
  return {
    binding: {
      id: opts.id,
      projectId: P,
      provider: opts.provider,
      role: opts.role ?? 'deploy',
      label: '',
      config: opts.config ?? {},
      active: opts.active ?? true,
      createdAt: new Date('2026-10-01T00:00:00Z'),
    },
    connection: {
      id: `c-${opts.id}`,
      provider: opts.provider,
      config: opts.connectionConfig ?? {},
      active: true,
      lastHealthStatus: opts.lastHealthStatus ?? 'ok',
      lastHealthDetail: null,
      lastHealthAt: new Date('2026-10-07T00:00:00Z'),
      breakerOpenedAt: null,
    },
  };
}

beforeEach(() => {
  repository = null;
  environments = new Map();
  pairs = [];
});

describe('the integrations status read: a card is connected only where something is', () => {
  it('reads a github.com repository no binding reaches as not connected, naming the cost and GitHub as the fix', async () => {
    repository = 'github.com/SidCorp-co/forge';
    const cards = await buildIntegrationsStatusCards(P);
    const repo = cards.find((c) => c.key === 'repository');
    expect(repo?.status).toBe('not_configured');
    expect(repo?.detail).toContain('cannot tell what already shipped');
    expect(repo?.meta?.connectProvider).toBe('github');
  });

  it('reads the repository as connected through the GitHub binding that reaches it, with that binding health', async () => {
    repository = 'github.com/SidCorp-co/forge';
    pairs = [
      pair({
        id: 'g1',
        provider: 'github',
        role: 'source',
        config: { owner: 'SidCorp-co', repo: 'forge' },
      }),
    ];
    const repo = (await buildIntegrationsStatusCards(P)).find((c) => c.key.endsWith('repository'));
    expect(repo?.key).toBe('github:repository');
    expect(repo?.status).toBe('connected');
  });

  it('reads a repository whose only reaching binding is switched off as disabled, not connected', async () => {
    repository = 'github.com/SidCorp-co/forge';
    pairs = [pair({ id: 'g1', provider: 'github', role: 'source', active: false })];
    const repo = (await buildIntegrationsStatusCards(P)).find((c) => c.key.endsWith('repository'));
    expect(repo?.status).toBe('disabled');
  });

  it('offers a GitHub card on every project, so the App install is reachable from the tab', async () => {
    repository = 'github.com/SidCorp-co/forge';
    const github = (await buildIntegrationsStatusCards(P)).find((c) => c.key === 'github');
    expect(github?.status).toBe('not_configured');
  });

  it('carries no core-health card: runners, database, MCP mount and agent are not integrations', async () => {
    const keys = (await buildIntegrationsStatusCards(P)).map((c) => c.key);
    expect(keys.filter((k) => ['runners', 'postgres', 'mcp', 'claude'].includes(k))).toEqual([]);
  });

  it('names two deploy bindings of one provider apart: the environment where one names it, else its application', async () => {
    environments = new Map([['b-dev', { name: 'dev', trigger: 'auto' }]]);
    pairs = [
      pair({
        id: 'b-dev',
        provider: 'coolify',
        config: { targets: [{ id: 'primary', label: 'primary', resourceUuid: 'e0o0c40k' }] },
      }),
      pair({
        id: 'b-other',
        provider: 'coolify',
        config: { targets: [{ id: 'primary', label: 'primary', resourceUuid: 'y8w4c4ks' }] },
      }),
    ];
    const coolify = (await buildIntegrationsStatusCards(P)).filter((c) =>
      c.key.startsWith('coolify'),
    );
    expect(coolify.map((c) => c.meta?.name)).toEqual(['dev', 'app y8w4c4ks']);
    expect(new Set(coolify.map((c) => c.label)).size).toBe(2);
  });

  it('names two bindings that share every name by their id rather than repeat one text', async () => {
    pairs = [
      pair({ id: 'aaaaaaaa-1', provider: 'coolify' }),
      pair({ id: 'bbbbbbbb-2', provider: 'coolify' }),
    ];
    const names = (await buildIntegrationsStatusCards(P))
      .filter((c) => c.key.startsWith('coolify'))
      .map((c) => c.meta?.name);
    expect(names).toEqual(['binding aaaaaaaa', 'binding bbbbbbbb']);
  });
});
