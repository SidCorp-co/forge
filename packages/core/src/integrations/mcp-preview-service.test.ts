import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BindingWithConnection } from './store.js';

const resolveSessionMcpServers = vi.fn();
const stateDeclaredMcpNames = vi.fn(async () => [] as string[]);
const listBindingsForProject = vi.fn(async () => [] as BindingWithConnection[]);
const listAgentGrantedBindings = vi.fn(
  async (_projectId: string, _provider: string) => [] as BindingWithConnection[],
);

vi.mock('../jobs/resolve-job-mcp-servers.js', () => ({ resolveSessionMcpServers }));
vi.mock('../jobs/stage-overrides.js', () => ({ stateDeclaredMcpNames }));
vi.mock('./agent-access-store.js', () => ({ listAgentGrantedBindings }));
vi.mock('./store.js', async (original) => ({
  ...(await original<typeof import('./store.js')>()),
  listBindingsForProject,
}));

(await import('./register-all.js')).registerAllIntegrations();

const { buildMcpPreview } = await import('./mcp-preview-service.js');

const PROJECT = 'p-1';

/** A sentry binding: one direct-mcp provider that is not multiBinding. */
function sentryPair(over: { id?: string; agentAccess?: string; secretsEnc?: string | null } = {}) {
  return {
    binding: {
      id: over.id ?? 'b-sentry',
      projectId: PROJECT,
      provider: 'sentry',
      role: 'service',
      stages: null,
      label: '',
      config: { orgSlug: 'acme', instanceUrl: 'https://sentry.example' },
      active: true,
      agentAccess: over.agentAccess ?? 'all',
      integrationSecret: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    connection: {
      id: 'c-sentry',
      provider: 'sentry',
      config: {},
      active: true,
      secretsEnc: over.secretsEnc === undefined ? 'enc' : over.secretsEnc,
      lastHealthStatus: 'ok',
      lastHealthAt: new Date(0),
      breakerOpenedAt: null,
    },
  } as unknown as BindingWithConnection;
}

function resolvedAs(args: {
  resolvedNames: string[];
  integrationServers?: { name: string; bindingId: string }[];
  droppedNames?: string[];
}) {
  resolveSessionMcpServers.mockResolvedValue({
    mcpServers: Object.fromEntries(args.resolvedNames.map((n) => [n, { secret: 'never-read' }])),
    resolvedNames: args.resolvedNames,
    integrationServers: args.integrationServers ?? [],
    droppedNames: args.droppedNames ?? [],
  });
}

/** An epodsystem binding: the one direct-mcp provider that declares `multiBinding`. */
function epodPair(over: { id: string; label: string; agentAccess?: string }) {
  return {
    binding: {
      id: over.id,
      projectId: PROJECT,
      provider: 'epodsystem',
      role: 'service',
      stages: null,
      label: over.label,
      config: { storeSlug: 'acme', storeName: 'Acme' },
      active: true,
      agentAccess: over.agentAccess ?? 'all',
      integrationSecret: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    connection: {
      id: `c-${over.id}`,
      provider: 'epodsystem',
      config: {},
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
  stateDeclaredMcpNames.mockResolvedValue([]);
  listBindingsForProject.mockResolvedValue([]);
  listAgentGrantedBindings.mockResolvedValue([]);
  resolvedAs({ resolvedNames: [] });
});

describe('buildMcpPreview — every source, or none (ISS-1191)', () => {
  it('reports a server the project declared in pipelineConfig, which the old preview omitted', async () => {
    resolvedAs({ resolvedNames: ['playwright'] });
    const { servers } = await buildMcpPreview(PROJECT);
    expect(servers.map((s) => s.serverName)).toContain('playwright');
  });

  it('names the source that put each server in the set', async () => {
    resolvedAs({ resolvedNames: ['playwright'] });
    const { servers } = await buildMcpPreview(PROJECT);
    expect(servers.find((s) => s.serverName === 'playwright')?.source).toBe('project');
    expect(servers.find((s) => s.serverName === 'sentry')?.source).toBe('integration');
  });

  it('reads no url off a project-declared server spec', async () => {
    resolvedAs({ resolvedNames: ['playwright'] });
    const { servers } = await buildMcpPreview(PROJECT);
    expect(servers.find((s) => s.serverName === 'playwright')?.url).toBeNull();
  });

  it('reads no headers off a project-declared server spec', async () => {
    resolvedAs({ resolvedNames: ['playwright'] });
    const { servers } = await buildMcpPreview(PROJECT);
    expect(servers.find((s) => s.serverName === 'playwright')?.headers).toBeNull();
  });

  it('carries the pipeline-declared names resolution did not supply', async () => {
    resolvedAs({ resolvedNames: [], droppedNames: ['nope'] });
    expect((await buildMcpPreview(PROJECT)).droppedNames).toEqual(['nope']);
  });

  it('names the per-state-only servers a project-wide session does not carry', async () => {
    resolvedAs({ resolvedNames: ['playwright'] });
    stateDeclaredMcpNames.mockResolvedValue(['playwright', 'chrome-devtools-mcp']);
    expect((await buildMcpPreview(PROJECT)).stateOnlyNames).toEqual(['chrome-devtools-mcp']);
  });

  it('reports as reaching the agent exactly the names the session resolver resolved', async () => {
    listBindingsForProject.mockResolvedValue([sentryPair()]);
    listAgentGrantedBindings.mockImplementation(async (_p: string, provider: string) =>
      provider === 'sentry' ? [sentryPair()] : [],
    );
    resolvedAs({
      resolvedNames: ['playwright', 'sentry'],
      integrationServers: [{ name: 'sentry', bindingId: 'b-sentry' }],
    });
    const { servers } = await buildMcpPreview(PROJECT);
    const reaching = servers.filter((s) => s.willInject).map((s) => s.serverName);
    expect([...new Set(reaching)].sort()).toEqual(['playwright', 'sentry']);
  });

  it('does not repeat an integration server as a project row', async () => {
    listBindingsForProject.mockResolvedValue([sentryPair()]);
    listAgentGrantedBindings.mockImplementation(async (_p: string, provider: string) =>
      provider === 'sentry' ? [sentryPair()] : [],
    );
    resolvedAs({
      resolvedNames: ['sentry'],
      integrationServers: [{ name: 'sentry', bindingId: 'b-sentry' }],
    });
    const { servers } = await buildMcpPreview(PROJECT);
    expect(servers.filter((s) => s.serverName === 'sentry')).toHaveLength(1);
  });

  it('calls a binding the resolver skipped not_resolved, where it used to read ok', async () => {
    // Active, credentialed, granted, unshadowed — and the resolver still produced nothing, which
    // is what an undecryptable credential or a null buildEntry looks like from here.
    listBindingsForProject.mockResolvedValue([sentryPair()]);
    listAgentGrantedBindings.mockImplementation(async (_p: string, provider: string) =>
      provider === 'sentry' ? [sentryPair()] : [],
    );
    resolvedAs({ resolvedNames: [] });
    const { servers } = await buildMcpPreview(PROJECT);
    const row = servers.find((s) => s.serverName === 'sentry');
    expect(row?.willInject).toBe(false);
    expect(row?.reason).toBe('not_resolved');
  });

  it('still names the first unmet condition ahead of not_resolved', async () => {
    listBindingsForProject.mockResolvedValue([sentryPair({ agentAccess: 'none' })]);
    resolvedAs({ resolvedNames: [] });
    const { servers } = await buildMcpPreview(PROJECT);
    expect(servers.find((s) => s.serverName === 'sentry')?.reason).toBe('not_granted');
  });

  it('separates a connected, healthy binding nobody granted from a provider with no binding', async () => {
    // Measured across 36 projects on 2026-09-25: four carry a Sentry binding and every one of them
    // is ungranted, the other 32 carry none. The two states are one observation on every surface
    // that reports a count, and telling them apart is the whole of what this issue was filed for.
    listBindingsForProject.mockResolvedValue([sentryPair({ agentAccess: 'none' })]);
    resolvedAs({ resolvedNames: [] });
    const { servers } = await buildMcpPreview(PROJECT);
    const ungranted = servers.find((s) => s.provider === 'sentry');
    const missing = servers.find((s) => s.provider === 'postman');
    expect(ungranted?.reason).toBe('not_granted');
    expect(missing?.reason).toBe('not_configured');
  });

  it('shows the ungranted binding as connected and healthy while it reaches no agent', async () => {
    listBindingsForProject.mockResolvedValue([sentryPair({ agentAccess: 'none' })]);
    resolvedAs({ resolvedNames: [] });
    const row = (await buildMcpPreview(PROJECT)).servers.find((s) => s.provider === 'sentry');
    expect(row).toMatchObject({ configured: true, active: true, lastHealthStatus: 'ok' });
    expect(row?.willInject).toBe(false);
  });

  it('marks only the binding that delivered, where two share one server name', async () => {
    // Sentry is single-slot: both bindings carry the name `sentry`, and the resolver builds an
    // entry for the oldest granted one. Keyed on the name, the loser reads ok too.
    const winner = sentryPair({ id: 'b-win' });
    const loser = sentryPair({ id: 'b-lose', agentAccess: 'none' });
    listBindingsForProject.mockResolvedValue([winner, loser]);
    listAgentGrantedBindings.mockImplementation(async (_p: string, provider: string) =>
      provider === 'sentry' ? [winner] : [],
    );
    resolvedAs({
      resolvedNames: ['sentry'],
      integrationServers: [{ name: 'sentry', bindingId: 'b-win' }],
    });
    const { servers } = await buildMcpPreview(PROJECT);
    expect(servers.find((s) => s.bindingId === 'b-win')?.willInject).toBe(true);
    expect(servers.find((s) => s.bindingId === 'b-lose')?.willInject).toBe(false);
  });

  it('gives the losing binding its own reason rather than the winner’s verdict', async () => {
    const winner = sentryPair({ id: 'b-win' });
    const loser = sentryPair({ id: 'b-lose' });
    listBindingsForProject.mockResolvedValue([winner, loser]);
    listAgentGrantedBindings.mockImplementation(async (_p: string, provider: string) =>
      provider === 'sentry' ? [winner, loser] : [],
    );
    resolvedAs({
      resolvedNames: ['sentry'],
      integrationServers: [{ name: 'sentry', bindingId: 'b-win' }],
    });
    const { servers } = await buildMcpPreview(PROJECT);
    expect(servers.find((s) => s.bindingId === 'b-lose')?.reason).toBe('shadowed');
  });

  it('adds no project row for a name an integration binding already delivered', async () => {
    const winner = sentryPair({ id: 'b-win' });
    listBindingsForProject.mockResolvedValue([winner, sentryPair({ id: 'b-lose' })]);
    listAgentGrantedBindings.mockImplementation(async (_p: string, provider: string) =>
      provider === 'sentry' ? [winner] : [],
    );
    resolvedAs({
      resolvedNames: ['sentry'],
      integrationServers: [{ name: 'sentry', bindingId: 'b-win' }],
    });
    const { servers } = await buildMcpPreview(PROJECT);
    expect(servers.filter((s) => s.source === 'project')).toEqual([]);
  });

  it('calls a multiBinding binding whose name another binding holds shadowed, not not_resolved', async () => {
    // `mcpServerNameFor` maps `-` to `_`, so two epodsystem labels differing only there land on one
    // server name. The resolver keeps the first claim; the second is shadowed BY it. Read as
    // not_resolved, the panel tells the operator to re-enter a credential that is working.
    const winner = epodPair({ id: 'b-first', label: 'north-shop' });
    const loser = epodPair({ id: 'b-second', label: 'north_shop' });
    listBindingsForProject.mockResolvedValue([winner, loser]);
    listAgentGrantedBindings.mockImplementation(async (_p: string, provider: string) =>
      provider === 'epodsystem' ? [winner, loser] : [],
    );
    resolvedAs({
      resolvedNames: ['epodsystem_north_shop'],
      integrationServers: [{ name: 'epodsystem_north_shop', bindingId: 'b-first' }],
    });
    const { servers } = await buildMcpPreview(PROJECT);
    expect(servers.find((s) => s.bindingId === 'b-first')?.reason).toBe('ok');
    expect(servers.find((s) => s.bindingId === 'b-second')?.reason).toBe('shadowed');
  });

  it('still calls a multiBinding binding under a name nobody holds not_resolved', async () => {
    // The boundary the test above must not swallow: a granted, credentialed epodsystem binding
    // whose own name the resolver produced for nobody is the decrypt-or-buildEntry failure, and
    // `not_resolved` is exactly right for it.
    const only = epodPair({ id: 'b-only', label: 'south-shop' });
    listBindingsForProject.mockResolvedValue([only]);
    listAgentGrantedBindings.mockImplementation(async (_p: string, provider: string) =>
      provider === 'epodsystem' ? [only] : [],
    );
    resolvedAs({ resolvedNames: [] });
    const { servers } = await buildMcpPreview(PROJECT);
    expect(servers.find((s) => s.bindingId === 'b-only')?.reason).toBe('not_resolved');
  });

  it('answers rows for a project with nothing configured at all', async () => {
    // Why the panel needs no empty state, measured rather than argued: every `direct-mcp` provider
    // the registry holds contributes a `not_configured` row, so the servers list is never empty
    // for any project. Delete that row and this goes red before the panel renders a bare list.
    resolvedAs({ resolvedNames: [] });
    const { servers } = await buildMcpPreview(PROJECT);
    expect(servers.length).toBeGreaterThan(0);
    expect(servers.every((s) => s.reason === 'not_configured')).toBe(true);
  });

  it('never reads a spec out of the credential-bearing map the resolver returns', async () => {
    resolvedAs({ resolvedNames: ['playwright'] });
    const { servers } = await buildMcpPreview(PROJECT);
    expect(JSON.stringify(servers)).not.toContain('never-read');
  });
});
