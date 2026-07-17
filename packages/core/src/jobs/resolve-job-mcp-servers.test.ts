import { beforeEach, describe, expect, it, vi } from 'vitest';

// Locks the dispatched-path MCP injection contract (ISS-683): per-state
// catalog shorthand (e.g. `chrome-devtools-mcp: true`) must resolve to a real
// spec, not survive as a literal boolean — see the ISS-683 comment in
// resolve-job-mcp-servers.ts for how the boolean previously leaked through.
const limitResults: unknown[][] = [];
const limit = vi.fn(() => Promise.resolve(limitResults.shift() ?? []));
const where = vi.fn(() => ({ limit }));
const from = vi.fn(() => ({ where }));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from })) },
}));

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Integration resolvers are unrelated to the catalog-expansion/dedupe logic
// under test here — stub them as pass-through (mirrors dispatcher.test.ts).
vi.mock('../integrations/postman/resolver.js', () => ({
  applyPostmanMcpServers: vi.fn(
    async (_projectId: string, current: Record<string, unknown> | null) => current,
  ),
}));
vi.mock('../integrations/epodsystem/resolver.js', () => ({
  applyEpodsystemMcpServers: vi.fn(
    async (_projectId: string, current: Record<string, unknown> | null) => current,
  ),
}));
vi.mock('../integrations/sentry/resolver.js', () => ({
  applySentryMcpServers: vi.fn(
    async (_projectId: string, current: Record<string, unknown> | null) => current,
  ),
}));

const { resolveJobMcpServers, dedupeBrowserServers, sweepIntegrationSentinels } = await import(
  './resolve-job-mcp-servers.js'
);

beforeEach(() => {
  limitResults.length = 0;
  limit.mockClear();
});

describe('resolveJobMcpServers (ISS-683)', () => {
  it('testing-stage resolve: expands per-state catalog shorthand, dedupes playwright, no dropped names', async () => {
    // Owner-enforced live shape (2026-07-17): top-level pipelineConfig.mcpServers
    // is `{}` (browser servers never belong there — mcp-per-project-config-strict
    // runbook); the browser tool comes ONLY from the per-state `testing` entry.
    limitResults.push([{ agentConfig: { pipelineConfig: { mcpServers: {} } } }]);
    const out = await resolveJobMcpServers({
      projectId: 'p-1',
      stageMcpServers: { playwright: true, 'chrome-devtools-mcp': true },
      stageDeclaredNames: ['playwright', 'chrome-devtools-mcp'],
    });

    // The resolved chrome-devtools-mcp entry must be a REAL spec object, not
    // the literal `true` sentinel that used to leak through unexpanded.
    expect(out.mcpServers?.['chrome-devtools-mcp']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: [
        'chrome-devtools-mcp@latest',
        '--headless',
        '--isolated',
        '--chrome-arg=--no-sandbox',
        '--chrome-arg=--disable-setuid-sandbox',
      ],
      env: {},
    });
    expect(out.mcpServers?.playwright).toBeUndefined();
    expect(out.resolvedNames).toEqual(['chrome-devtools-mcp']);
    expect(out.droppedNames).toEqual([]);
  });

  it('per-state browser injection does NOT depend on top-level being populated (guard, ISS-683 owner override)', async () => {
    // Top-level `{}` on every dispatch (the enforced state) must never starve
    // a stage that declares its own browser servers.
    limitResults.push([{ agentConfig: { pipelineConfig: { mcpServers: {} } } }]);
    const withStage = await resolveJobMcpServers({
      projectId: 'p-1',
      stageMcpServers: { 'chrome-devtools-mcp': true },
      stageDeclaredNames: ['chrome-devtools-mcp'],
    });
    expect(withStage.mcpServers?.['chrome-devtools-mcp']).toMatchObject({ type: 'stdio', command: 'npx' });
    expect(withStage.droppedNames).toEqual([]);

    // And a stage that declares nothing gets nothing back — top-level `{}`
    // must stay `{}`, it is not a fallback source of browser servers.
    limitResults.push([{ agentConfig: { pipelineConfig: { mcpServers: {} } } }]);
    const withoutStage = await resolveJobMcpServers({
      projectId: 'p-1',
      stageMcpServers: null,
      stageDeclaredNames: null,
    });
    expect(withoutStage.mcpServers).toBeNull();
  });

  it('per-state raw object spec overrides the project default by name (no expansion needed)', async () => {
    limitResults.push([{ agentConfig: { pipelineConfig: { mcpServers: { playwright: true } } } }]);
    const out = await resolveJobMcpServers({
      projectId: 'p-1',
      stageMcpServers: { playwright: { type: 'stdio', command: 'custom-playwright' } },
      stageDeclaredNames: ['playwright'],
    });
    expect(out.mcpServers?.playwright).toEqual({ type: 'stdio', command: 'custom-playwright' });
  });

  it('surfaces a declared-but-unresolvable stage name in droppedNames', async () => {
    limitResults.push([{ agentConfig: null }]);
    const out = await resolveJobMcpServers({
      projectId: 'p-1',
      stageMcpServers: { typo_server: true },
      stageDeclaredNames: ['typo_server'],
    });
    expect(out.mcpServers?.typo_server).toBeUndefined();
    expect(out.droppedNames).toEqual(['typo_server']);
  });

  it('integration sentinel true on the stage still reaches the integration resolver unexpanded', async () => {
    limitResults.push([{ agentConfig: null }]);
    const out = await resolveJobMcpServers({
      projectId: 'p-1',
      stageMcpServers: { sentry: true },
      stageDeclaredNames: ['sentry'],
    });
    // No active sentry integration in this test's mock (pass-through), and the
    // sentinel sweep removes any leftover `true` for an integration name.
    expect(out.mcpServers?.sentry).toBeUndefined();
    expect(out.droppedNames).toEqual(['sentry']);
  });
});

describe('dedupeBrowserServers (ISS-581)', () => {
  it('drops playwright when chrome-devtools-mcp is also present', () => {
    const out = dedupeBrowserServers({ playwright: {}, 'chrome-devtools-mcp': {} });
    expect(out).toEqual({ 'chrome-devtools-mcp': {} });
  });

  it('leaves a lone browser server untouched', () => {
    const out = dedupeBrowserServers({ playwright: {} });
    expect(out).toEqual({ playwright: {} });
  });

  it('passes null through', () => {
    expect(dedupeBrowserServers(null)).toBeNull();
  });
});

describe('sweepIntegrationSentinels', () => {
  it('removes a leftover true sentinel for an integration name', () => {
    expect(sweepIntegrationSentinels({ sentry: true, playwright: {} })).toEqual({ playwright: {} });
  });

  it('returns null when sweeping empties the map', () => {
    expect(sweepIntegrationSentinels({ sentry: true })).toBeNull();
  });

  it('is a no-op when there is nothing to sweep', () => {
    expect(sweepIntegrationSentinels(null)).toBeNull();
    expect(sweepIntegrationSentinels({ playwright: {} })).toEqual({ playwright: {} });
  });
});
