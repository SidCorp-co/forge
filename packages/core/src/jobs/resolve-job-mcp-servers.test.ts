import { beforeEach, describe, expect, it, vi } from 'vitest';

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

// The granted-integration layer is unrelated to the catalog-expansion/dedupe/opt-out logic under
// test here. ISS-1071 collapsed three per-provider `apply*McpServers` mocks into this one, which is
// the point: there is one registry-driven resolver now, so a new provider adds no mock here.
const applyGrantedMcpServers = vi.fn(
  async (_projectId: string, current: Record<string, unknown> | null) => ({
    map: current,
    names: [] as string[],
    bindingIds: [] as string[],
  }),
);
vi.mock('../integrations/mcp-resolver.js', () => ({ applyGrantedMcpServers }));

const { resolveJobMcpServers, resolveSessionMcpServers, dedupeBrowserServers } = await import(
  './resolve-job-mcp-servers.js'
);

beforeEach(() => {
  limitResults.length = 0;
  limit.mockClear();
  applyGrantedMcpServers.mockClear();
  applyGrantedMcpServers.mockImplementation(async (_p, current) => ({
    map: current,
    names: [] as string[],
    bindingIds: [] as string[],
  }));
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
    expect(withStage.mcpServers?.['chrome-devtools-mcp']).toMatchObject({
      type: 'stdio',
      command: 'npx',
    });
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

  it('a provider name written on a stage is dropped as the unknown name it now is (ISS-1071)', async () => {
    limitResults.push([{ agentConfig: null }]);
    const out = await resolveJobMcpServers({
      projectId: 'p-1',
      stageMcpServers: { sentry: true },
      stageDeclaredNames: ['sentry'],
    });
    // `sentry: true` is no longer a sentinel anybody reads. It is a name the catalog does not hold,
    // so it drops here exactly as a typo would, and it is reported rather than silently absorbed.
    expect(out.mcpServers?.sentry).toBeUndefined();
    expect(out.droppedNames).toEqual(['sentry']);
  });

  it('a granted binding supplies its server by name, after the stage merge (ISS-1071)', async () => {
    limitResults.push([{ agentConfig: { pipelineConfig: { mcpServers: {} } } }]);
    applyGrantedMcpServers.mockImplementation(async (_p, current) => ({
      map: { ...(current ?? {}), sentry: { type: 'http', url: 'https://sentry.example' } },
      names: ['sentry'],
      bindingIds: ['b-sentry'],
    }));
    const out = await resolveJobMcpServers({
      projectId: 'p-1',
      stageMcpServers: { playwright: true },
      stageDeclaredNames: ['playwright'],
    });
    expect(applyGrantedMcpServers).toHaveBeenCalledWith('p-1', expect.anything());
    expect(out.mcpServers?.sentry).toEqual({ type: 'http', url: 'https://sentry.example' });
    // The grant is not a DECLARED name, so it is not something a stage can have dropped.
    expect(out.droppedNames).toEqual([]);
  });

  it('a stage `false` beats the project default (ISS-1038)', async () => {
    limitResults.push([{ agentConfig: { pipelineConfig: { mcpServers: { playwright: true } } } }]);
    const out = await resolveJobMcpServers({
      projectId: 'p-1',
      stageMcpServers: { playwright: false },
      stageDeclaredNames: [],
    });
    expect(out.mcpServers?.playwright).toBeUndefined();
    expect(out.resolvedNames).toEqual([]);
  });

  it('a stage `false` beats a GRANTED integration server too (ISS-1038)', async () => {
    limitResults.push([{ agentConfig: { pipelineConfig: { mcpServers: {} } } }]);
    applyGrantedMcpServers.mockImplementation(async (_p, current) => ({
      map: { ...(current ?? {}), sentry: { type: 'http', url: 'https://sentry.example' } },
      names: ['sentry'],
      bindingIds: ['b-sentry'],
    }));
    const out = await resolveJobMcpServers({
      projectId: 'p-1',
      stageMcpServers: { sentry: false, playwright: true },
      stageDeclaredNames: ['playwright'],
    });
    // The grant layers on AFTER the opt-out is applied, so this documents the order that actually
    // runs rather than the one a reader might assume: a stage cannot refuse a granted server.
    expect(out.mcpServers?.sentry).toEqual({ type: 'http', url: 'https://sentry.example' });
    expect(out.mcpServers?.playwright).toBeDefined();
  });

  it('a stage `false` for a name nobody supplied changes nothing', async () => {
    limitResults.push([{ agentConfig: { pipelineConfig: { mcpServers: { playwright: true } } } }]);
    const out = await resolveJobMcpServers({
      projectId: 'p-1',
      stageMcpServers: { 'chrome-devtools-mcp': false },
      stageDeclaredNames: [],
    });
    expect(out.mcpServers?.playwright).toBeDefined();
    expect(out.droppedNames).toEqual([]);
  });
});

// ISS-1043 — the stage-less entry a BOX calls for a session it starts itself.
// The dispatch entry above is exercised through `stageMcpServers`; nothing
// covered the project-default-only path this route hands to a resident master.
describe('resolveSessionMcpServers (ISS-1043)', () => {
  it('expands a project-default catalog shorthand into a full spec', async () => {
    limitResults.push([{ agentConfig: { pipelineConfig: { mcpServers: { playwright: true } } } }]);
    const out = await resolveSessionMcpServers('p-1');
    expect(out.mcpServers?.playwright).toMatchObject({ type: 'stdio', command: 'npx' });
    expect(out.resolvedNames).toEqual(['playwright']);
    expect(out.droppedNames).toEqual([]);
  });

  it('names a project-default provider name as dropped, never passing the bare `true` on', async () => {
    limitResults.push([{ agentConfig: { pipelineConfig: { mcpServers: { epodsystem: true } } } }]);
    const out = await resolveSessionMcpServers('p-1');
    // `epodsystem` is not a catalog name, so it drops at expansion. What matters for the box is the
    // negative: it never reaches `mcp/config.rs` as the bare `true` that file skips with a warning.
    expect(out.mcpServers?.epodsystem).toBeUndefined();
    expect(out.resolvedNames).toEqual([]);
    expect(out.droppedNames).toEqual(['epodsystem']);
  });

  it('answers a project that declares nothing with no servers and nothing dropped', async () => {
    limitResults.push([{ agentConfig: null }]);
    const out = await resolveSessionMcpServers('p-1');
    expect(out.mcpServers).toBeNull();
    expect(out.resolvedNames).toEqual([]);
    expect(out.droppedNames).toEqual([]);
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

// ISS-1071 deleted `sweepIntegrationSentinels`. It existed to clear a `true` an integration
// resolver had left behind when no binding matched; with no sentinel to leave behind there is
// nothing to sweep, and a provider name now drops at expansion like any other unknown name — which
// the two `droppedNames` assertions above are the coverage for.
