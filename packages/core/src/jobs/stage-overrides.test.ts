import { describe, expect, it, vi, beforeEach } from 'vitest';

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

const { extractStageStatus, resolveStageOverrides, resolveProjectDefaultMcpServers } = await import(
  './stage-overrides.js'
);

beforeEach(() => {
  limitResults.length = 0;
  limit.mockClear();
});

describe('extractStageStatus', () => {
  it('returns the string when payload.stageStatus is set', () => {
    expect(extractStageStatus({ stageStatus: 'approved' })).toBe('approved');
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

  it('returns empty when project has no agentConfig', async () => {
    limitResults.push([{ agentConfig: null }]);
    const r = await resolveStageOverrides('p-1', { stageStatus: 'developed' });
    expect(r.model).toBeNull();
  });

  it('returns the stage config from agentConfig.pipelineConfig.states', async () => {
    limitResults.push([
      {
        agentConfig: {
          pipelineConfig: {
            states: {
              developed: {
                skillName: 'forge-review',
                model: 'sonnet',
                allowedTools: ['Bash'],
                permissionMode: 'acceptEdits',
                timeoutSeconds: 1800,
                systemPrompt: { mode: 'append', extras: 'X' },
                sessionGroup: 'verification',
              },
            },
          },
        },
      },
    ]);
    const r = await resolveStageOverrides('p-1', { stageStatus: 'developed' });
    expect(r.model).toBe('sonnet');
    expect(r.allowedTools).toEqual(['Bash']);
    expect(r.permissionMode).toBe('acceptEdits');
    expect(r.timeoutSeconds).toBe(1800);
    expect(r.systemPrompt).toEqual({ mode: 'append', extras: 'X' });
    expect(r.sessionGroup).toBe('verification');
  });

  it('returns empty when the stage status is missing from the config', async () => {
    limitResults.push([
      { agentConfig: { pipelineConfig: { states: { approved: { model: 'opus' } } } } },
    ]);
    const r = await resolveStageOverrides('p-1', { stageStatus: 'developed' });
    expect(r.model).toBeNull();
  });

  it('swallows DB errors and returns empty', async () => {
    limit.mockRejectedValueOnce(new Error('db down'));
    const r = await resolveStageOverrides('p-1', { stageStatus: 'developed' });
    expect(r.model).toBeNull();
  });
});

describe('resolveProjectDefaultMcpServers', () => {
  it('returns empty when project has no agentConfig', async () => {
    limitResults.push([{ agentConfig: null }]);
    expect(await resolveProjectDefaultMcpServers('p-1')).toEqual({});
  });

  it('returns empty when pipelineConfig has no mcpServers', async () => {
    limitResults.push([{ agentConfig: { pipelineConfig: { states: {} } } }]);
    expect(await resolveProjectDefaultMcpServers('p-1')).toEqual({});
  });

  it('expands the catalog shorthand from pipelineConfig.mcpServers', async () => {
    limitResults.push([
      { agentConfig: { pipelineConfig: { mcpServers: { playwright: true } } } },
    ]);
    const out = await resolveProjectDefaultMcpServers('p-1');
    expect(out.playwright).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@latest'],
      env: {},
    });
  });

  it('passes a raw custom spec object through verbatim', async () => {
    const custom = { type: 'http', url: 'https://x' };
    limitResults.push([{ agentConfig: { pipelineConfig: { mcpServers: { mine: custom } } } }]);
    const out = await resolveProjectDefaultMcpServers('p-1');
    expect(out.mine).toEqual(custom);
  });

  it('swallows DB errors and returns empty', async () => {
    limit.mockRejectedValueOnce(new Error('db down'));
    expect(await resolveProjectDefaultMcpServers('p-1')).toEqual({});
  });
});
