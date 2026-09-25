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
function sentryPair(over: { agentAccess?: string; secretsEnc?: string | null } = {}) {
  return {
    binding: {
      id: 'b-sentry',
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
  integrationNames?: string[];
  droppedNames?: string[];
}) {
  resolveSessionMcpServers.mockResolvedValue({
    mcpServers: Object.fromEntries(args.resolvedNames.map((n) => [n, { secret: 'never-read' }])),
    resolvedNames: args.resolvedNames,
    integrationNames: args.integrationNames ?? [],
    droppedNames: args.droppedNames ?? [],
  });
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
    resolvedAs({ resolvedNames: ['playwright', 'sentry'], integrationNames: ['sentry'] });
    const { servers } = await buildMcpPreview(PROJECT);
    const reaching = servers.filter((s) => s.willInject).map((s) => s.serverName);
    expect([...new Set(reaching)].sort()).toEqual(['playwright', 'sentry']);
  });

  it('does not repeat an integration server as a project row', async () => {
    listBindingsForProject.mockResolvedValue([sentryPair()]);
    listAgentGrantedBindings.mockImplementation(async (_p: string, provider: string) =>
      provider === 'sentry' ? [sentryPair()] : [],
    );
    resolvedAs({ resolvedNames: ['sentry'], integrationNames: ['sentry'] });
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
    resolvedAs({ resolvedNames: [], integrationNames: [] });
    const { servers } = await buildMcpPreview(PROJECT);
    const row = servers.find((s) => s.serverName === 'sentry');
    expect(row?.willInject).toBe(false);
    expect(row?.reason).toBe('not_resolved');
  });

  it('still names the first unmet condition ahead of not_resolved', async () => {
    listBindingsForProject.mockResolvedValue([sentryPair({ agentAccess: 'none' })]);
    resolvedAs({ resolvedNames: [], integrationNames: [] });
    const { servers } = await buildMcpPreview(PROJECT);
    expect(servers.find((s) => s.serverName === 'sentry')?.reason).toBe('not_granted');
  });

  it('separates a connected, healthy binding nobody granted from a provider with no binding', async () => {
    // Measured across 36 projects on 2026-09-25: four carry a Sentry binding and every one of them
    // is ungranted, the other 32 carry none. The two states are one observation on every surface
    // that reports a count, and telling them apart is the whole of what this issue was filed for.
    listBindingsForProject.mockResolvedValue([sentryPair({ agentAccess: 'none' })]);
    resolvedAs({ resolvedNames: [], integrationNames: [] });
    const { servers } = await buildMcpPreview(PROJECT);
    const ungranted = servers.find((s) => s.provider === 'sentry');
    const missing = servers.find((s) => s.provider === 'postman');
    expect(ungranted?.reason).toBe('not_granted');
    expect(missing?.reason).toBe('not_configured');
  });

  it('shows the ungranted binding as connected and healthy while it reaches no agent', async () => {
    listBindingsForProject.mockResolvedValue([sentryPair({ agentAccess: 'none' })]);
    resolvedAs({ resolvedNames: [], integrationNames: [] });
    const row = (await buildMcpPreview(PROJECT)).servers.find((s) => s.provider === 'sentry');
    expect(row).toMatchObject({ configured: true, active: true, lastHealthStatus: 'ok' });
    expect(row?.willInject).toBe(false);
  });

  it('never reads a spec out of the credential-bearing map the resolver returns', async () => {
    resolvedAs({ resolvedNames: ['playwright'] });
    const { servers } = await buildMcpPreview(PROJECT);
    expect(JSON.stringify(servers)).not.toContain('never-read');
  });
});
