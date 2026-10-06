import { describe, expect, it } from 'vitest';
import { type RetargetFacts, retargetRefusal } from './rules.js';

const screen = { type: 'screen', key: '/projects/hop/workflows', node: null };
const req12 = { type: 'requirement', key: 'REQ-12', node: null };
const base: RetargetFacts = {
  key: 'FB-1',
  current: screen,
  next: req12,
  contract: null,
  redacted: false,
  revision: null,
};

describe('retargeting a feedback item (ISS-264)', () => {
  it('lets an item about a screen move to the requirement that records its rule', () => {
    expect(retargetRefusal(base)).toBeNull();
  });

  it('refuses the target the item already has, naming it', () => {
    const r = retargetRefusal({ ...base, next: screen });
    expect(r?.code).toBe('FEEDBACK_TARGET_UNCHANGED');
    expect(r?.path).toBe('/screen');
    expect(r?.detail).toContain('FB-1 is already about screen /projects/hop/workflows');
  });

  it('tells a step of one workflow from the whole workflow, so moving onto the step is a change', () => {
    const flow = { type: 'workflow', key: 'feedback-triage', node: null };
    expect(
      retargetRefusal({ ...base, current: flow, next: { ...flow, node: 'step decide' } }),
    ).toBeNull();
    expect(
      retargetRefusal({
        ...base,
        current: { ...flow, node: 'step decide' },
        next: { ...flow, node: 'step decide' },
      })?.code,
    ).toBe('FEEDBACK_TARGET_UNCHANGED');
  });

  it('refuses an item core filed about a contract version, before anything else', () => {
    const r = retargetRefusal({ ...base, contract: 'hop/orders@2.0.0', next: base.current });
    expect(r?.code).toBe('FEEDBACK_TARGET_CORE_FILED');
    expect(r?.detail).toContain('contract version hop/orders@2.0.0');
  });

  it('refuses a screen for an item whose reporter data was deleted, and nothing else', () => {
    const toScreen = retargetRefusal({ ...base, current: req12, next: screen, redacted: true });
    expect(toScreen?.code).toBe('FEEDBACK_ALREADY_REDACTED');
    expect(toScreen?.path).toBe('/screen');
    expect(retargetRefusal({ ...base, redacted: true })).toBeNull();
  });

  it('keeps a revision-routed item on the requirement its suggestion revises', () => {
    const r = retargetRefusal({
      ...base,
      revision: { revises: 'REQ-3', nextRequirement: 'REQ-12' },
    });
    expect(r?.code).toBe('FEEDBACK_ROUTE_TARGET_MISMATCH');
    expect(r?.detail).toContain('routed as a revision of REQ-3');
    expect(
      retargetRefusal({
        ...base,
        next: { type: 'issue', key: 'ISS-9', node: null },
        revision: { revises: 'REQ-12', nextRequirement: 'REQ-12' },
      }),
    ).toBeNull();
  });
});
