// ISS-1038 — `buildMcpInjectionState` composes the declaration projection with
// the project's bindings. The projection's own semantics are pinned in
// pipeline/mcp-catalog.test.ts and against the dispatcher in
// jobs/resolve-job-mcp-servers.test.ts; what is asserted here is the
// composition: every switchable provider appears, whether a binding backs it,
// and the scopes travelling through unchanged.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const agentConfig = { value: null as unknown };
const limit = vi.fn(async () =>
  agentConfig.value === undefined ? [] : [{ agentConfig: agentConfig.value }],
);
const where = vi.fn(() => ({ limit }));
const from = vi.fn(() => ({ where }));
vi.mock('../db/client.js', () => ({ db: { select: vi.fn(() => ({ from })) } }));

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const bindings = { value: [] as Array<{ binding: { provider: string } }> };
vi.mock('./store.js', () => ({
  listBindingsForProject: async () => bindings.value,
}));

const { buildMcpInjectionState, isMcpInjectionProvider, MCP_INJECTION_PROVIDERS } = await import(
  './mcp-injection-service.js'
);

beforeEach(() => {
  agentConfig.value = null;
  bindings.value = [];
});

describe('isMcpInjectionProvider (ISS-1038)', () => {
  it('accepts every provider the dispatcher resolves', () => {
    for (const p of MCP_INJECTION_PROVIDERS) expect(isMcpInjectionProvider(p)).toBe(true);
  });

  it('rejects a provider with no MCP adapter', () => {
    // rocketchat and github are real integrations that inject no MCP server.
    expect(isMcpInjectionProvider('rocketchat')).toBe(false);
    expect(isMcpInjectionProvider('github')).toBe(false);
    expect(isMcpInjectionProvider('')).toBe(false);
  });

  it('rejects a LABELLED epodsystem name — the switch is per provider', () => {
    // `applyEpodsystemMcpServers` opts into every active binding from any
    // `epodsystem*` sentinel, so a per-label switch would promise scoping the
    // resolver does not do.
    expect(isMcpInjectionProvider('epodsystem_store_a')).toBe(false);
  });
});

describe('buildMcpInjectionState (ISS-1038)', () => {
  it('answers a project with no config with every provider undeclared and unconfigured', async () => {
    const state = await buildMcpInjectionState('p-1');
    expect(state.map((s) => s.provider)).toEqual(['postman', 'epodsystem', 'sentry']);
    for (const s of state) {
      expect(s).toMatchObject({ declaredDefault: false, configured: false });
      expect(s.declaredStates).toEqual([]);
      expect(s.excludedStates).toEqual([]);
    }
  });

  it('reports a binding as configured whether or not it is declared', async () => {
    bindings.value = [{ binding: { provider: 'epodsystem' } }];
    const state = await buildMcpInjectionState('p-1');
    const epodsystem = state.find((s) => s.provider === 'epodsystem');
    // The exact shape this issue was filed on: connected, and reaching nothing.
    expect(epodsystem).toMatchObject({ configured: true, declaredDefault: false });
  });

  it('carries the declaring and excluding stages through', async () => {
    agentConfig.value = {
      pipelineConfig: {
        mcpServers: { epodsystem: true },
        states: {
          open: { mcpServers: { epodsystem: false } },
          testing: { mcpServers: { sentry: true } },
        },
      },
    };
    const state = await buildMcpInjectionState('p-1');
    expect(state.find((s) => s.provider === 'epodsystem')).toMatchObject({
      declaredDefault: true,
      excludedStates: ['open'],
    });
    expect(state.find((s) => s.provider === 'sentry')).toMatchObject({
      declaredDefault: false,
      declaredStates: ['testing'],
    });
  });

  it('reads a labelled sentinel as the epodsystem provider being declared', async () => {
    agentConfig.value = { pipelineConfig: { mcpServers: { epodsystem_store_a: true } } };
    const state = await buildMcpInjectionState('p-1');
    expect(state.find((s) => s.provider === 'epodsystem')?.declaredDefault).toBe(true);
  });
});
