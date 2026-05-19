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
