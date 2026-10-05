import { changedSincePlan } from '@forge/contracts/requirements';
import { describe, expect, it } from 'vitest';
import { planLine } from '../workflows/run-context-plan.js';

// requirement-to-delivery `impact`: a revision after agreed flags only the issues tracing a BC it changed
describe('changedSincePlan', () => {
  const planned = { plan: 'do it', plannedRevision: 2, currentRevision: 3 };

  it('flags an issue tracing a BC a later revision changed', () => {
    expect(changedSincePlan({ ...planned, changedTraced: [{ code: 'BC-2', revision: 3 }] })).toBe(
      true,
    );
  });

  it('leaves an issue whose traced BCs the later revision did not change', () => {
    expect(changedSincePlan({ ...planned, changedTraced: [] })).toBe(false);
  });

  it('leaves an issue at the current revision, a re-pin of it included', () => {
    expect(changedSincePlan({ ...planned, plannedRevision: 3, changedTraced: [] })).toBe(false);
  });

  it('flags a plan that names no revision while the requirement has a head', () => {
    expect(changedSincePlan({ ...planned, plannedRevision: null, changedTraced: [] })).toBe(true);
    expect(
      changedSincePlan({
        ...planned,
        plannedRevision: null,
        currentRevision: null,
        changedTraced: [],
      }),
    ).toBe(false);
  });

  it('never flags an issue with no plan', () => {
    expect(
      changedSincePlan({ ...planned, plan: '  ', changedTraced: [{ code: 'BC-1', revision: 3 }] }),
    ).toBe(false);
  });
});

describe('planLine', () => {
  it('names each changed BC and the revision that changed it', () => {
    const line = planLine(true, 2, 4, [
      { code: 'BC-1', revision: 3 },
      { code: 'BC-4', revision: 4 },
    ]);
    expect(line).toContain('REQUIREMENT_CHANGED_SINCE_PLAN');
    expect(line).toContain('BC-1 changed in revision 3, BC-4 changed in revision 4');
  });

  it('says an older plan still holds when nothing it traces changed', () => {
    expect(planLine(false, 2, 4)).toContain('no BC it traces changed');
  });
});
