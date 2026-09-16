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

const {
  resolveJobMcpServers,
  resolveSessionMcpServers,
  dedupeBrowserServers,
  sweepIntegrationSentinels,
} = await import('./resolve-job-mcp-servers.js');

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

  it('names a project-default integration sentinel with no active integration as dropped', async () => {
    limitResults.push([{ agentConfig: { pipelineConfig: { mcpServers: { epodsystem: true } } } }]);
    const out = await resolveSessionMcpServers('p-1');
    // The integration resolvers are pass-through here — no active binding — so
    // the sentinel is swept rather than reaching the box as the bare `true`
    // that `mcp/config.rs` skips with only a warning.
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

// ISS-1038 — a stage's explicit `false` is an opt-OUT and had to start working.
// `expandMcpServers` omits a `false` rather than recording it, so before this
// the stage map reaching the merge simply had no entry for the name and the
// project default's `true` won: an operator could set the control and nothing
// changed. These lock the behaviour in both directions, because the fix must
// not stop a project that declares the sentinel from receiving it — `pixelight`
// and `butlocs` both carry one today.
describe('resolveJobMcpServers stage opt-out (ISS-1038)', () => {
  it('a stage `false` removes a catalog server the project default declared', async () => {
    limitResults.push([
      { agentConfig: { pipelineConfig: { mcpServers: { 'chrome-devtools-mcp': true } } } },
    ]);
    const out = await resolveJobMcpServers({
      projectId: 'p-1',
      stageMcpServers: { 'chrome-devtools-mcp': false },
      stageDeclaredNames: [],
    });
    expect(out.mcpServers?.['chrome-devtools-mcp']).toBeUndefined();
    expect(out.resolvedNames).not.toContain('chrome-devtools-mcp');
  });

  it('a stage `false` reaches the integration resolver as an absent sentinel', async () => {
    const { applyEpodsystemMcpServers } = await import('../integrations/epodsystem/resolver.js');
    limitResults.push([
      { agentConfig: { pipelineConfig: { mcpServers: { epodsystem: true } } } },
    ]);
    await resolveJobMcpServers({
      projectId: 'p-1',
      stageMcpServers: { epodsystem: false },
      stageDeclaredNames: [],
    });
    // What the resolver is HANDED is the whole assertion: it injects only
    // against a `true` sentinel, so a map still carrying one here is a stage
    // opt-out that did nothing.
    const handed = vi.mocked(applyEpodsystemMcpServers).mock.calls.at(-1)?.[1];
    expect(handed?.epodsystem).toBeUndefined();
  });

  it('a project default sentinel with no stage override still reaches the resolver', async () => {
    const { applyEpodsystemMcpServers } = await import('../integrations/epodsystem/resolver.js');
    limitResults.push([
      { agentConfig: { pipelineConfig: { mcpServers: { epodsystem: true } } } },
    ]);
    await resolveJobMcpServers({
      projectId: 'p-1',
      stageMcpServers: null,
      stageDeclaredNames: null,
    });
    const handed = vi.mocked(applyEpodsystemMcpServers).mock.calls.at(-1)?.[1];
    expect(handed?.epodsystem).toBe(true);
  });

  it('a stage that excludes a LABEL still hands the resolver the bare sentinel it inherited', async () => {
    const { applyEpodsystemMcpServers } = await import('../integrations/epodsystem/resolver.js');
    limitResults.push([
      { agentConfig: { pipelineConfig: { mcpServers: { epodsystem: true } } } },
    ]);
    await resolveJobMcpServers({
      projectId: 'p-1',
      stageMcpServers: { epodsystem_store: false },
      stageDeclaredNames: [],
    });
    const handed = vi.mocked(applyEpodsystemMcpServers).mock.calls.at(-1)?.[1];
    expect(handed?.epodsystem).toBe(true);
  });
});

// ISS-1038 — the parity that matters. `projectDeclaredProviders` is what the
// Integrations panel's header and `buildMcpPreview`'s `not_declared` gate both
// read; this asserts it against what the DISPATCHER actually hands the
// integration resolver for the same config. A screen that reports a state the
// dispatcher disagrees with is the defect this issue was filed on, so the two
// are compared directly rather than each being checked against a fixture.
describe('panel/dispatcher parity for epodsystem (ISS-1038)', () => {
  const cases: Array<{
    name: string;
    mcpServers: Record<string, unknown>;
    states?: Record<string, { mcpServers?: Record<string, unknown> }>;
    stage: string | null;
  }> = [
    { name: 'nothing declared anywhere', mcpServers: {}, stage: null },
    { name: 'bare project-default sentinel', mcpServers: { epodsystem: true }, stage: null },
    { name: 'labelled project-default sentinel', mcpServers: { epodsystem_a: true }, stage: null },
    {
      name: 'stage declares it, project default does not',
      mcpServers: {},
      states: { testing: { mcpServers: { epodsystem: true } } },
      stage: 'testing',
    },
    {
      name: 'stage turns the project default back off',
      mcpServers: { epodsystem: true },
      states: { testing: { mcpServers: { epodsystem: false } } },
      stage: 'testing',
    },
    {
      name: 'stage excludes a LABEL while the bare sentinel is inherited',
      mcpServers: { epodsystem: true },
      states: { testing: { mcpServers: { epodsystem_store: false } } },
      stage: 'testing',
    },
    {
      name: 'stage holds one matching true beside one matching false',
      mcpServers: {},
      states: { testing: { mcpServers: { epodsystem_a: true, epodsystem_b: false } } },
      stage: 'testing',
    },
    {
      name: 'an object spec under the provider name is a custom server, not a sentinel',
      mcpServers: { epodsystem: { type: 'http', url: 'https://example.invalid' } },
      stage: null,
    },
  ];

  for (const c of cases) {
    it(`agrees with the dispatcher: ${c.name}`, async () => {
      const { projectDeclaredProviders } = await import('../pipeline/mcp-catalog.js');
      const { applyEpodsystemMcpServers } = await import('../integrations/epodsystem/resolver.js');

      const pipelineConfig = { mcpServers: c.mcpServers, states: c.states };
      const [declaration] = projectDeclaredProviders(pipelineConfig, ['epodsystem']);

      // What the PANEL would say for this scope.
      const panelSaysDeclared = c.stage
        ? declaration.declaredStates.includes(c.stage) ||
          (declaration.declaredDefault && !declaration.excludedStates.includes(c.stage))
        : declaration.declaredDefault;

      // What the DISPATCHER does for the same scope: the resolver injects only
      // against a surviving `true` sentinel, so what it is handed is the answer.
      limitResults.push([{ agentConfig: { pipelineConfig } }]);
      const stageMap = c.stage ? (c.states?.[c.stage]?.mcpServers ?? null) : null;
      await resolveJobMcpServers({
        projectId: 'p-1',
        stageMcpServers: stageMap,
        stageDeclaredNames: stageMap ? Object.keys(stageMap) : null,
      });
      const handed = vi.mocked(applyEpodsystemMcpServers).mock.calls.at(-1)?.[1] ?? {};
      const dispatcherInjects = Object.entries(handed).some(
        ([name, value]) =>
          value === true && (name === 'epodsystem' || name.startsWith('epodsystem_')),
      );

      expect(panelSaysDeclared).toBe(dispatcherInjects);
    });
  }
});
