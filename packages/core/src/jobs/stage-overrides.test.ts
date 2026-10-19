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

const {
  extractStageStatus,
  resolveStageOverrides,
  resolveProjectDefaultMcpServers,
  resolveDefaultModel,
  DEFAULT_STAGE_MODELS,
} = await import('./stage-overrides.js');

beforeEach(() => {
  limitResults.length = 0;
  limit.mockClear();
});

describe('extractStageStatus', () => {
  it('returns the string when payload.stageStatus is set', () => {
    expect(extractStageStatus({ stageStatus: 'in_progress' })).toBe('in_progress');
  });

  it('returns null for missing/empty/non-string', () => {
    expect(extractStageStatus(null)).toBeNull();
    expect(extractStageStatus({})).toBeNull();
    expect(extractStageStatus({ stageStatus: '' })).toBeNull();
    expect(extractStageStatus({ stageStatus: 123 })).toBeNull();
  });
});

describe('resolveStageOverrides', () => {
  it('returns empty when no stageStatus stamped (legacy job)', async () => {
    const r = await resolveStageOverrides('p-1', {});
    expect(r.systemPrompt).toBeNull();
    expect(r.model).toBeNull();
    expect(r.allowedTools).toBeNull();
  });

  it('applies the default policy model when project has no agentConfig (ISS-535)', async () => {
    limitResults.push([{ agentConfig: null }]);
    const r = await resolveStageOverrides('p-1', { stageStatus: 'in_progress' });
    expect(r.model).toBe('sonnet');
    expect(r.allowedTools).toBeNull(); // only model gets the default; rest stay empty
  });

  it('returns the stage config from agentConfig.pipelineConfig.states', async () => {
    limitResults.push([
      {
        agentConfig: {
          pipelineConfig: {
            states: {
              in_progress: {
                skillName: 'forge-review',
                model: 'sonnet',
                allowedTools: ['Bash'],
                permissionMode: 'acceptEdits',
                timeoutSeconds: 1800,
                systemPrompt: { mode: 'append', extras: 'X' },
              },
            },
          },
        },
      },
    ]);
    const r = await resolveStageOverrides('p-1', { stageStatus: 'in_progress' });
    expect(r.model).toBe('sonnet');
    expect(r.allowedTools).toEqual(['Bash']);
    expect(r.permissionMode).toBe('acceptEdits');
    expect(r.timeoutSeconds).toBe(1800);
    expect(r.systemPrompt).toEqual({ mode: 'append', extras: 'X' });
  });

  it('collects declaredNames from truthy per-state mcpServers keys, excluding false/null (ISS-623 W2)', async () => {
    limitResults.push([
      {
        agentConfig: {
          pipelineConfig: {
            states: {
              in_progress: { mcpServers: { epodsystem: true, playwright: false, shop: true } },
            },
          },
        },
      },
    ]);
    const r = await resolveStageOverrides('p-1', { stageStatus: 'in_progress' });
    expect(r.declaredNames).toEqual(expect.arrayContaining(['epodsystem', 'shop']));
    expect(r.declaredNames).not.toContain('playwright');
  });

  it('applies the default policy model when the stage status is missing from the config (ISS-535)', async () => {
    limitResults.push([
      { agentConfig: { pipelineConfig: { states: { awaiting_release: { model: 'haiku' } } } } },
    ]);
    const r = await resolveStageOverrides('p-1', { stageStatus: 'in_progress' });
    expect(r.model).toBe('sonnet');
  });

  it('per-project .model wins over the default policy (ISS-535)', async () => {
    limitResults.push([
      { agentConfig: { pipelineConfig: { states: { in_progress: { model: 'haiku' } } } } },
    ]);
    const r = await resolveStageOverrides('p-1', { stageStatus: 'in_progress' });
    expect(r.model).toBe('haiku');
  });

  it('applies the default policy model when states[status].model is null (ISS-535)', async () => {
    limitResults.push([
      {
        agentConfig: {
          pipelineConfig: { states: { in_progress: { skillName: 'issue-flow', model: null } } },
        },
      },
    ]);
    const r = await resolveStageOverrides('p-1', { stageStatus: 'in_progress' });
    expect(r.model).toBe('sonnet');
  });

  it('falls through to no default for statuses absent from the policy table (ISS-535)', async () => {
    limitResults.push([{ agentConfig: null }]);
    const r = await resolveStageOverrides('p-1', { stageStatus: 'staging' });
    expect(r.model).toBeNull();
  });

  it('still applies the default policy model on DB error (ISS-535)', async () => {
    // loadStageMap swallows the error and returns null → the hardcoded policy
    // table still routes the model (it needs no DB).
    limit.mockRejectedValueOnce(new Error('db down'));
    const r = await resolveStageOverrides('p-1', { stageStatus: 'in_progress' });
    expect(r.model).toBe('sonnet');
  });
});

describe('resolveDefaultModel (ISS-535)', () => {
  it('covers the four dispatchable statuses and no rung of the deleted ladder', () => {
    expect(DEFAULT_STAGE_MODELS).toEqual({
      open: 'sonnet',
      in_progress: 'sonnet',
      needs_info: 'sonnet',
      awaiting_release: 'sonnet',
    });
  });

  it('returns the tier for a known status and null otherwise', () => {
    expect(resolveDefaultModel('open')).toBe('sonnet');
    expect(resolveDefaultModel('awaiting_release')).toBe('sonnet');
    expect(resolveDefaultModel('approved')).toBeNull();
    expect(resolveDefaultModel('staging')).toBeNull();
    expect(resolveDefaultModel('bogus')).toBeNull();
  });

  it('exports no tier-escalation helper', async () => {
    const mod = await import('./stage-overrides.js');
    expect('escalateModel' in mod).toBe(false);
  });
});

describe('resolveProjectDefaultMcpServers', () => {
  it('returns empty when project has no agentConfig', async () => {
    limitResults.push([{ agentConfig: null }]);
    expect(await resolveProjectDefaultMcpServers('p-1')).toEqual({
      servers: {},
      declaredNames: [],
    });
  });

  it('returns empty when pipelineConfig has no mcpServers', async () => {
    limitResults.push([{ agentConfig: { pipelineConfig: { states: {} } } }]);
    expect(await resolveProjectDefaultMcpServers('p-1')).toEqual({
      servers: {},
      declaredNames: [],
    });
  });

  it('expands the catalog shorthand from pipelineConfig.mcpServers', async () => {
    limitResults.push([{ agentConfig: { pipelineConfig: { mcpServers: { playwright: true } } } }]);
    const out = await resolveProjectDefaultMcpServers('p-1');
    expect(out.servers.playwright).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@latest', '--headless', '--isolated', '--no-sandbox'],
      env: {},
    });
    expect(out.declaredNames).toEqual(['playwright']);
  });

  it('passes a raw custom spec object through verbatim', async () => {
    const custom = { type: 'http', url: 'https://x' };
    limitResults.push([{ agentConfig: { pipelineConfig: { mcpServers: { mine: custom } } } }]);
    const out = await resolveProjectDefaultMcpServers('p-1');
    expect(out.servers.mine).toEqual(custom);
    expect(out.declaredNames).toEqual(['mine']);
  });

  it('does not include a declared name for an unknown catalog shorthand (dropped by expandMcpServers)', async () => {
    limitResults.push([{ agentConfig: { pipelineConfig: { mcpServers: { shop: true } } } }]);
    const out = await resolveProjectDefaultMcpServers('p-1');
    expect(out.servers).toEqual({});
    expect(out.declaredNames).toEqual(['shop']);
  });

  it('swallows DB errors and returns empty', async () => {
    limit.mockRejectedValueOnce(new Error('db down'));
    expect(await resolveProjectDefaultMcpServers('p-1')).toEqual({
      servers: {},
      declaredNames: [],
    });
  });
});
