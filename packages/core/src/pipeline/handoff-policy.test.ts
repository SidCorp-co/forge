import { describe, expect, it } from 'vitest';
import { resolveHandoffsPolicy } from './handoff-policy.js';

describe('resolveHandoffsPolicy', () => {
  it('defaults to enabled with nothing injected when no explicit config', () => {
    expect(resolveHandoffsPolicy(null)).toEqual({
      enabled: true,
      injectFromSteps: [],
      fallbackToRawIssueFieldIfMissing: true,
    });
  });

  it('explicit enabled=false overrides default-on', () => {
    const r = resolveHandoffsPolicy({ handoffs: { enabled: false } } as never);
    expect(r.enabled).toBe(false);
  });

  it('explicit injectFromSteps replaces the empty default', () => {
    const r = resolveHandoffsPolicy({
      handoffs: { enabled: true, injectFromSteps: ['code'] },
    } as never);
    expect(r.injectFromSteps).toEqual(['code']);
  });

  it('explicit injectFromSteps narrows non-handoff steps out (release ignored, clarify kept)', () => {
    const r = resolveHandoffsPolicy({
      handoffs: {
        enabled: true,
        injectFromSteps: ['triage', 'release', 'plan', 'clarify'],
      },
    } as never);
    expect(r.injectFromSteps).toEqual(['triage', 'plan', 'clarify']);
  });
});
