import { describe, expect, it } from 'vitest';
import { resolveHandoffsPolicy } from './handoff-policy.js';

describe('resolveHandoffsPolicy', () => {
  it('defaults to enabled + warn + canonical injects when no explicit config', () => {
    expect(resolveHandoffsPolicy(null, 'plan')).toEqual({
      enabled: true,
      injectFromSteps: ['triage', 'clarify'],
      requireHandoffWrite: true,
      missingMarkerPolicy: 'warn',
      fallbackToRawIssueFieldIfMissing: true,
    });
  });

  it('triage default injectFromSteps is empty (no prior step)', () => {
    expect(resolveHandoffsPolicy(undefined, 'triage').injectFromSteps).toEqual([]);
  });

  it.each([
    ['clarify', ['triage']],
    ['plan', ['triage', 'clarify']],
    ['code', ['triage', 'plan']],
    ['review', ['triage', 'plan', 'code']],
    ['test', ['triage', 'plan', 'code']],
    ['fix', ['triage', 'plan', 'code', 'review']],
  ] as const)('canonical inject list for step=%s = %j', (step, expected) => {
    expect(resolveHandoffsPolicy(undefined, step).injectFromSteps).toEqual(expected);
  });

  it('non-handoff steps (release/custom/pm) default to empty inject', () => {
    expect(resolveHandoffsPolicy(undefined, 'release').injectFromSteps).toEqual([]);
    expect(resolveHandoffsPolicy(undefined, 'custom').injectFromSteps).toEqual([]);
    expect(resolveHandoffsPolicy(undefined, 'pm').injectFromSteps).toEqual([]);
  });

  it('explicit enabled=false overrides default-on', () => {
    const r = resolveHandoffsPolicy({ handoffs: { enabled: false } } as never, 'plan');
    expect(r.enabled).toBe(false);
    // Other fields still default
    expect(r.missingMarkerPolicy).toBe('warn');
  });

  it('explicit injectFromSteps replaces the default canonical list', () => {
    const r = resolveHandoffsPolicy(
      { handoffs: { enabled: true, injectFromSteps: ['code'] } } as never,
      'review',
    );
    expect(r.injectFromSteps).toEqual(['code']);
  });

  it('explicit injectFromSteps narrows non-handoff steps out (release ignored, clarify kept)', () => {
    const r = resolveHandoffsPolicy(
      {
        handoffs: {
          enabled: true,
          injectFromSteps: ['triage', 'release', 'plan', 'clarify'],
        },
      } as never,
      'code',
    );
    expect(r.injectFromSteps).toEqual(['triage', 'plan', 'clarify']);
  });

  it('explicit missingMarkerPolicy=fail overrides default warn', () => {
    const r = resolveHandoffsPolicy(
      { handoffs: { enabled: true, missingMarkerPolicy: 'fail' } } as never,
      'plan',
    );
    expect(r.missingMarkerPolicy).toBe('fail');
  });

  it('explicit requireHandoffWrite=false overrides default true', () => {
    const r = resolveHandoffsPolicy(
      { handoffs: { enabled: true, requireHandoffWrite: false } } as never,
      'plan',
    );
    expect(r.requireHandoffWrite).toBe(false);
  });
});
