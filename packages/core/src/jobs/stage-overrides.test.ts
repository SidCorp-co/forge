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
  applySkillMaintenanceCarveout,
  SKILL_MAINTENANCE_TOOLS,
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
      { agentConfig: { pipelineConfig: { states: { released: { model: 'haiku' } } } } },
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
  // cm:guard the table must name the STAGE_NAMES four and nothing else. A rung for a status no job stamps is a tier no dispatch can reach, and it was the presence of those rungs — not their values — that made this table read as a ladder after ISS-897 left one session.
  it('covers the four dispatchable statuses and no rung of the deleted ladder', () => {
    expect(DEFAULT_STAGE_MODELS).toEqual({
      open: 'sonnet',
      in_progress: 'sonnet',
      needs_info: 'sonnet',
      released: 'sonnet',
    });
  });

  it('returns the tier for a known status and null otherwise', () => {
    expect(resolveDefaultModel('open')).toBe('sonnet');
    expect(resolveDefaultModel('released')).toBe('sonnet');
    expect(resolveDefaultModel('approved')).toBeNull();
    expect(resolveDefaultModel('staging')).toBeNull();
    expect(resolveDefaultModel('bogus')).toBeNull();
  });

  // cm:why asserts the ABSENCE of a runtime tier bump — escalateModel (ISS-535) was deleted, and a re-add would silently reopen the ISS-766 cost loop that this fixed table exists to close
  it('exports no tier-escalation helper', async () => {
    const mod = await import('./stage-overrides.js');
    expect('escalateModel' in mod).toBe(false);
  });
});

describe('applySkillMaintenanceCarveout (ISS-637)', () => {
  function overridesWith(disallowedTools: string[] | null): {
    disallowedTools: string[] | null;
  } & Record<string, unknown> {
    return {
      systemPrompt: null,
      model: null,
      allowedTools: null,
      disallowedTools,
      permissionMode: null,
      timeoutSeconds: null,
      mcpServers: null,
      budget: null,
      declaredNames: null,
    };
  }

  it('removes only the non-destructive skill-write tools for a code job with the label', () => {
    const overrides = overridesWith([
      'mcp__forge__forge_skills_create',
      'mcp__forge__forge_skills_delete',
      'mcp__forge__forge_skills_adopt',
      'mcp__forge__forge_skills_register',
      ...SKILL_MAINTENANCE_TOOLS,
      'mcp__forge__forge_memory_write',
      'mcp__forge__forge_coolify_deploy',
      'Bash',
      // biome-ignore lint/suspicious/noExplicitAny: test fixture cast
    ]) as any;
    const removed = applySkillMaintenanceCarveout(overrides, {
      hasSkillMaintenanceLabel: true,
      jobType: 'code',
    });
    expect(removed).toBe(SKILL_MAINTENANCE_TOOLS.length);
    for (const tool of SKILL_MAINTENANCE_TOOLS) {
      expect(overrides.disallowedTools).not.toContain(tool);
    }
    // destructive ops + unrelated tools stay denied
    expect(overrides.disallowedTools).toEqual(
      expect.arrayContaining([
        'mcp__forge__forge_skills_create',
        'mcp__forge__forge_skills_delete',
        'mcp__forge__forge_skills_adopt',
        'mcp__forge__forge_skills_register',
        'mcp__forge__forge_memory_write',
        'mcp__forge__forge_coolify_deploy',
        'Bash',
      ]),
    );
  });

  it('removes the tools for a fix job with the label too', () => {
    // biome-ignore lint/suspicious/noExplicitAny: test fixture cast
    const overrides = overridesWith([...SKILL_MAINTENANCE_TOOLS]) as any;
    const removed = applySkillMaintenanceCarveout(overrides, {
      hasSkillMaintenanceLabel: true,
      jobType: 'fix',
    });
    expect(removed).toBe(SKILL_MAINTENANCE_TOOLS.length);
    expect(overrides.disallowedTools).toEqual([]);
  });

  it('does not fire without the label, even for code/fix jobs', () => {
    // biome-ignore lint/suspicious/noExplicitAny: test fixture cast
    const overrides = overridesWith([...SKILL_MAINTENANCE_TOOLS]) as any;
    const removed = applySkillMaintenanceCarveout(overrides, {
      hasSkillMaintenanceLabel: false,
      jobType: 'code',
    });
    expect(removed).toBe(0);
    expect(overrides.disallowedTools).toEqual([...SKILL_MAINTENANCE_TOOLS]);
  });

  it('does not fire for review/test/triage jobs even with the label', () => {
    for (const jobType of ['review', 'test', 'triage']) {
      // biome-ignore lint/suspicious/noExplicitAny: test fixture cast
      const overrides = overridesWith([...SKILL_MAINTENANCE_TOOLS]) as any;
      const removed = applySkillMaintenanceCarveout(overrides, {
        hasSkillMaintenanceLabel: true,
        jobType,
      });
      expect(removed).toBe(0);
      expect(overrides.disallowedTools).toEqual([...SKILL_MAINTENANCE_TOOLS]);
    }
  });

  it('does not crash when disallowedTools is null, returns 0', () => {
    // biome-ignore lint/suspicious/noExplicitAny: test fixture cast
    const overrides = overridesWith(null) as any;
    const removed = applySkillMaintenanceCarveout(overrides, {
      hasSkillMaintenanceLabel: true,
      jobType: 'code',
    });
    expect(removed).toBe(0);
    expect(overrides.disallowedTools).toBeNull();
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
