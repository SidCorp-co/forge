import { describe, expect, it } from 'vitest';
import {
  PIPELINE_CONFIG_DEFAULTS,
  STEP_TOGGLE_KEYS,
  mergePipelineConfig,
  pipelineConfigPatchSchema,
  pipelineConfigSchema,
  stepToggleSchema,
} from './pipeline-config-schema.js';

describe('stepToggleSchema', () => {
  it('accepts boolean form', () => {
    expect(stepToggleSchema.parse(true)).toBe(true);
    expect(stepToggleSchema.parse(false)).toBe(false);
  });

  it('accepts object form with runner + model', () => {
    const v = stepToggleSchema.parse({ enabled: true, runner: 'antigravity', model: 'g3-pro' });
    expect(v).toEqual({ enabled: true, runner: 'antigravity', model: 'g3-pro' });
  });

  it('accepts object form with only enabled', () => {
    expect(stepToggleSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it('rejects non-boolean / non-object', () => {
    expect(() => stepToggleSchema.parse(1)).toThrow();
    expect(() => stepToggleSchema.parse('yes')).toThrow();
    expect(() => stepToggleSchema.parse(null)).toThrow();
  });

  it('rejects object missing enabled', () => {
    expect(() => stepToggleSchema.parse({ runner: 'claude-code' })).toThrow();
  });
});

describe('pipelineConfigSchema', () => {
  it('accepts an empty document (all fields optional)', () => {
    expect(pipelineConfigSchema.parse({})).toEqual({});
  });

  it('accepts a v0 boolean-toggle document', () => {
    const v0 = {
      enabled: true,
      autoTriage: true,
      autoCode: false,
    };
    expect(pipelineConfigSchema.parse(v0)).toEqual(v0);
  });

  it('accepts mixed boolean + object toggles', () => {
    const doc = {
      enabled: true,
      autoTriage: true,
      autoCode: { enabled: true, runner: 'antigravity' },
    };
    expect(pipelineConfigSchema.parse(doc)).toEqual(doc);
  });

  it('drops unknown keys (legacy clarified, pipelineSteps)', () => {
    const legacy = {
      enabled: true,
      clarified: 'something',
      pipelineSteps: [{ status: 'open', skill: 'forge-triage' }],
      previewEnabled: false,
    };
    const out = pipelineConfigSchema.parse(legacy);
    expect(out).toEqual({ enabled: true });
    expect((out as Record<string, unknown>).clarified).toBeUndefined();
    expect((out as Record<string, unknown>).pipelineSteps).toBeUndefined();
  });

  it('accepts autoClarify as a first-class toggle (ISS-171)', () => {
    const out = pipelineConfigSchema.parse({ enabled: true, autoClarify: true });
    expect(out.autoClarify).toBe(true);
  });

  it('silently drops legacy recovery keys (no longer surfaced)', () => {
    const legacy = {
      enabled: true,
      recoveryMaxAttempts: 5,
      recoveryWindowHours: 24,
      recoveryByFailureKind: { transient: 10 },
    };
    const out = pipelineConfigSchema.parse(legacy);
    expect(out).toEqual({ enabled: true });
  });
});

describe('PIPELINE_CONFIG_DEFAULTS', () => {
  it('parses cleanly through the schema', () => {
    expect(() => pipelineConfigSchema.parse(PIPELINE_CONFIG_DEFAULTS)).not.toThrow();
  });

  it('exposes states defaults', () => {
    expect(PIPELINE_CONFIG_DEFAULTS.enabled).toBe(false);
    expect(PIPELINE_CONFIG_DEFAULTS.states).toBeDefined();
  });
});

describe('STEP_TOGGLE_KEYS', () => {
  it('is exactly the eight steps the orchestrator enqueues', () => {
    expect([...STEP_TOGGLE_KEYS].sort()).toEqual(
      [
        'autoClarify',
        'autoCode',
        'autoFix',
        'autoPlan',
        'autoRelease',
        'autoReview',
        'autoTest',
        'autoTriage',
      ].sort(),
    );
  });
});

describe('pipelineConfigPatchSchema', () => {
  it('accepts pipelineConfig fields plus runnerFallback', () => {
    const patch = {
      enabled: true,
      autoCode: true,
      runnerFallback: ['antigravity', 'claude-code'],
    };
    expect(pipelineConfigPatchSchema.parse(patch)).toEqual(patch);
  });

  it('accepts only runnerFallback', () => {
    expect(pipelineConfigPatchSchema.parse({ runnerFallback: ['claude-code'] })).toEqual({
      runnerFallback: ['claude-code'],
    });
  });

  it('rejects non-array runnerFallback', () => {
    expect(() => pipelineConfigPatchSchema.parse({ runnerFallback: 'claude-code' })).toThrow();
  });
});

describe('statesConfigSchema (ISS-110)', () => {
  it('accepts valid IssueStatus keys', () => {
    const patch = {
      states: {
        developed: { enabled: false, mode: 'auto' as const },
        testing: { enabled: true },
      },
    };
    expect(pipelineConfigSchema.parse(patch)).toEqual(patch);
  });

  it('rejects unknown status keys at the schema boundary', () => {
    // Review minor #3: prior `z.record(z.string(), ...)` accepted junk keys
    // silently. Tighten to z.enum(issueStatuses) so typos surface as 400.
    const patch = {
      states: {
        not_a_status: { enabled: false },
      },
    };
    expect(() => pipelineConfigSchema.parse(patch)).toThrow();
  });
});

describe('stageConfigSchema per-state overrides', () => {
  it('accepts skillName, model, allowedTools, permissionMode, timeoutSeconds', () => {
    const parsed = pipelineConfigSchema.parse({
      states: {
        developed: {
          skillName: 'forge-review',
          model: 'sonnet',
          allowedTools: ['Bash', 'mcp__forge__forge_issues'],
          permissionMode: 'acceptEdits',
          timeoutSeconds: 1800,
        },
      },
    });
    expect(parsed.states?.developed?.skillName).toBe('forge-review');
    expect(parsed.states?.developed?.model).toBe('sonnet');
    expect(parsed.states?.developed?.allowedTools).toEqual(['Bash', 'mcp__forge__forge_issues']);
    expect(parsed.states?.developed?.permissionMode).toBe('acceptEdits');
    expect(parsed.states?.developed?.timeoutSeconds).toBe(1800);
  });

  it('accepts systemPrompt append/replace + extras', () => {
    const parsed = pipelineConfigSchema.parse({
      states: {
        approved: {
          systemPrompt: { mode: 'replace', extras: 'CUSTOM RULES' },
        },
      },
    });
    expect(parsed.states?.approved?.systemPrompt).toEqual({
      mode: 'replace',
      extras: 'CUSTOM RULES',
    });
  });

  it('rejects unknown systemPrompt mode', () => {
    expect(() =>
      pipelineConfigSchema.parse({
        states: { approved: { systemPrompt: { mode: 'merge' } } },
      }),
    ).toThrow();
  });

  it('caps systemPrompt.extras at 32_000 chars', () => {
    expect(() =>
      pipelineConfigSchema.parse({
        states: { approved: { systemPrompt: { extras: 'x'.repeat(32_001) } } },
      }),
    ).toThrow();
  });

  it('accepts userPromptPolicy with all knobs', () => {
    const parsed = pipelineConfigSchema.parse({
      states: {
        developed: {
          userPromptPolicy: {
            includeFields: ['plan', 'acceptanceCriteria'],
            sessionContext: { depth: 5, fields: ['decisions', 'filesModified'] },
            fieldCaps: { plan: 20_000 },
            truncationStrategy: 'byte-cut',
          },
        },
      },
    });
    expect(parsed.states?.developed?.userPromptPolicy?.includeFields).toEqual([
      'plan',
      'acceptanceCriteria',
    ]);
    expect(parsed.states?.developed?.userPromptPolicy?.fieldCaps?.plan).toBe(20_000);
  });

  it('does NOT cap fieldCaps server-side (D3: operator owns budget)', () => {
    // 1 million chars — silly but allowed.
    expect(() =>
      pipelineConfigSchema.parse({
        states: { developed: { userPromptPolicy: { fieldCaps: { description: 1_000_000 } } } },
      }),
    ).not.toThrow();
  });

  it('accepts budget caps', () => {
    const parsed = pipelineConfigSchema.parse({
      states: {
        developed: { budget: { perRunUsd: 2.5, perMonthUsd: 100 } },
      },
    });
    expect(parsed.states?.developed?.budget).toEqual({ perRunUsd: 2.5, perMonthUsd: 100 });
  });

  it('accepts sessionGroup membership at the stage level', () => {
    const parsed = pipelineConfigSchema.parse({
      states: { developed: { sessionGroup: 'implementation' } },
    });
    expect(parsed.states?.developed?.sessionGroup).toBe('implementation');
  });
});

describe('sessionGroups + onResumeFail', () => {
  it('accepts a session-groups map keyed by group name', () => {
    const parsed = pipelineConfigSchema.parse({
      sessionGroups: {
        implementation: ['approved', 'developed'],
        verification: ['testing'],
      },
      onResumeFail: 'fresh',
    });
    expect(parsed.sessionGroups?.implementation).toEqual(['approved', 'developed']);
    expect(parsed.onResumeFail).toBe('fresh');
  });

  it('rejects unknown stage names in a group', () => {
    expect(() =>
      pipelineConfigSchema.parse({
        sessionGroups: { x: ['not_a_stage'] },
      }),
    ).toThrow();
  });

  it('rejects empty group', () => {
    expect(() =>
      pipelineConfigSchema.parse({ sessionGroups: { x: [] } }),
    ).toThrow();
  });

  it('rejects unknown onResumeFail policy', () => {
    expect(() =>
      pipelineConfigSchema.parse({ onResumeFail: 'retry' }),
    ).toThrow();
  });
});

describe('mergePipelineConfig', () => {
  it('merges patch onto current, preserving unknown keys for round-trip', () => {
    const current = { enabled: false, clarified: 'legacy', autoTriage: false };
    const patch = { enabled: true, autoTriage: true };
    const merged = mergePipelineConfig(current, patch);
    expect(merged).toEqual({ enabled: true, clarified: 'legacy', autoTriage: true });
  });

  it('handles null current', () => {
    expect(mergePipelineConfig(null, { enabled: true })).toEqual({ enabled: true });
  });
});
