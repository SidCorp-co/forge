import { describe, expect, it } from 'vitest';
import { breakdownBuilds } from './rules.js';

const pins = [{ workflowId: 'w1', flow: 'pilot' }];
type Breakdown = Parameters<typeof breakdownBuilds>[0];
const item = (over: Partial<Breakdown['issues'][number]>): Breakdown['issues'][number] =>
  ({
    title: 'Rebuild check',
    criteria: [{ body: 'it checks', tracesTo: 'BC-1' }],
    complexity: 's',
    ...over,
  }) as Breakdown['issues'][number];
const breakdown = (...issues: Breakdown['issues']): Breakdown => ({ issues }) as Breakdown;

describe('a breakdown issue names the steps on its build link (design-reconciliation breakdown)', () => {
  it('refuses steps on an issue that builds no design', () => {
    const out = breakdownBuilds(breakdown(item({ builds: null, steps: ['check'] })), pins);
    expect(out.refusals.map((r) => r.code)).toEqual(['SUGGESTION_BUILD_STEPS_UNBUILT']);
    expect(out.refusals[0]?.path).toBe('/payload/issues/0/steps');
  });

  it('refuses observed steps on an issue that builds no design, named or defaulted', () => {
    const named = breakdownBuilds(
      breakdown(item({ builds: null, observedSteps: ['o-extra'] })),
      pins,
    );
    expect(named.refusals.map((r) => r.path)).toEqual(['/payload/issues/0/observedSteps']);
    const unpinned = breakdownBuilds(breakdown(item({ steps: ['check'] })), []);
    expect(unpinned.refusals.map((r) => r.code)).toEqual(['SUGGESTION_BUILD_STEPS_UNBUILT']);
  });

  it('admits steps on an issue that builds the pinned design', () => {
    const out = breakdownBuilds(breakdown(item({ builds: 'pilot', steps: ['check'] })), pins);
    expect(out.refusals).toEqual([]);
    expect(out.builds[0]?.flow).toBe('pilot');
  });
});
