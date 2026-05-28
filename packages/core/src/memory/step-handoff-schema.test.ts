import { describe, expect, it } from 'vitest';
import {
  HANDOFF_STEPS,
  type HandoffStep,
  isHandoffStep,
  renderHandoffSchemaPrompt,
  renderTerminationBlock,
  stepHandoffSchema,
} from './step-handoff-schema.js';

describe('stepHandoffSchema', () => {
  it('accepts a complete triage payload', () => {
    const r = stepHandoffSchema.safeParse({
      step: 'triage',
      schema_version: 1,
      summary: 'Login fails on iOS Safari',
      suggestedApproach: 'Inspect JWT cookie SameSite policy + Safari ITP',
      complexity: 'm',
      risks: ['session loss for existing iOS users'],
      affectedAreas: ['auth/middleware', 'auth/cookie'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects triage with unknown complexity enum', () => {
    const r = stepHandoffSchema.safeParse({
      step: 'triage',
      schema_version: 1,
      summary: 's',
      suggestedApproach: 'a',
      complexity: 'huge',
      risks: [],
      affectedAreas: [],
    });
    expect(r.success).toBe(false);
  });

  it('accepts a complete code payload with commitSha', () => {
    const r = stepHandoffSchema.safeParse({
      step: 'code',
      schema_version: 1,
      filesModified: [{ path: 'src/auth/jwt.ts', op: 'edit' }],
      decisions: [{ what: 'use cookie fallback', why: 'header missing on Safari ITP' }],
      verificationCommands: ['pnpm test src/auth'],
      knownLimitations: [],
      commitSha: 'abcdef123',
    });
    expect(r.success).toBe(true);
  });

  it('rejects code payload with > 50 filesModified', () => {
    const r = stepHandoffSchema.safeParse({
      step: 'code',
      schema_version: 1,
      filesModified: Array.from({ length: 51 }, (_, i) => ({
        path: `f${i}.ts`,
        op: 'edit' as const,
      })),
      decisions: [],
      verificationCommands: [],
      knownLimitations: [],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown step discriminator', () => {
    const r = stepHandoffSchema.safeParse({
      step: 'unknown',
      schema_version: 1,
    });
    expect(r.success).toBe(false);
  });

  it('rejects schema_version other than 1', () => {
    const r = stepHandoffSchema.safeParse({
      step: 'review',
      schema_version: 2,
      verdict: 'pass',
      findings: [],
      reviewedDiffSha: 'abc',
    });
    expect(r.success).toBe(false);
  });

  it('accepts test payload with capped failure trace', () => {
    const r = stepHandoffSchema.safeParse({
      step: 'test',
      schema_version: 1,
      result: 'fail',
      failures: [{ test: 'auth/jwt.test.ts', trace: 'x'.repeat(500) }],
      flakyTests: [],
    });
    expect(r.success).toBe(true);
  });

  it('rejects test payload with trace > 500 chars', () => {
    const r = stepHandoffSchema.safeParse({
      step: 'test',
      schema_version: 1,
      result: 'fail',
      failures: [{ test: 't', trace: 'x'.repeat(501) }],
      flakyTests: [],
    });
    expect(r.success).toBe(false);
  });
});

describe('HANDOFF_STEPS + isHandoffStep', () => {
  it('lists the 6 expected handoff-emitting steps', () => {
    expect([...HANDOFF_STEPS]).toEqual(['triage', 'plan', 'code', 'review', 'test', 'fix']);
  });

  it('rejects non-handoff steps (clarify/release/custom/pm)', () => {
    expect(isHandoffStep('clarify')).toBe(false);
    expect(isHandoffStep('release')).toBe(false);
    expect(isHandoffStep('custom')).toBe(false);
    expect(isHandoffStep('pm')).toBe(false);
  });

  it('accepts every step in HANDOFF_STEPS', () => {
    for (const s of HANDOFF_STEPS) {
      expect(isHandoffStep(s)).toBe(true);
    }
  });
});

describe('renderHandoffSchemaPrompt', () => {
  it.each(HANDOFF_STEPS)('renders a stable prompt fragment for step=%s', (step) => {
    const out = renderHandoffSchemaPrompt(step as HandoffStep);
    // Snapshot keeps the output stable so prompt-cache hashing stays predictable.
    expect(out).toMatchSnapshot();
    // Sanity: every render must mention the step discriminator.
    expect(out).toContain(`"step": "${step}"`);
    expect(out).toContain('"schema_version": 1');
  });
});

describe('renderTerminationBlock', () => {
  const scope = {
    projectId: 'p-1',
    issueId: 'i-1',
    runId: 'r-1',
    attempt: 1,
  };

  it.each(HANDOFF_STEPS)('renders a stable termination block for step=%s', (step) => {
    const out = renderTerminationBlock({ step: step as HandoffStep, scope });
    expect(out).toMatchSnapshot();
    // Sanity: must instruct the agent to emit DONE last + cite the marker.
    expect(out).toContain('DONE');
    expect(out).toContain('HANDOFF_GIVE_UP');
    // Sanity: scope literals embedded so the agent doesn't guess them.
    expect(out).toContain(`"projectId": "${scope.projectId}"`);
    expect(out).toContain(`"sourceRef": "run:${scope.runId}/step:${step}/attempt:${scope.attempt}"`);
  });
});
