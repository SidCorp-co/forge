import { describe, expect, it } from 'vitest';
import { handoffInjectSteps } from './handoff-policy.js';

describe('handoffInjectSteps', () => {
  it.each([
    ['triage', []],
    ['clarify', ['triage']],
    ['plan', ['triage', 'clarify']],
    ['code', ['triage', 'plan']],
    ['review', ['triage', 'plan', 'code']],
    ['test', ['triage', 'plan', 'code']],
    ['fix', ['triage', 'plan', 'code', 'review']],
    ['drive', []],
  ] as const)('the prior steps a %s job is shown are %j', (step, expected) => {
    expect(handoffInjectSteps(step)).toEqual(expected);
  });

  it.each(['release', 'custom', 'pm', 'smoke'] as const)(
    'a %s job, which is no handoff step, is shown none',
    (jobType) => {
      expect(handoffInjectSteps(jobType)).toEqual([]);
    },
  );
});
