import { describe, expect, it } from 'vitest';
import {
  firstRequirementsCaseOwed,
  firstRequirementsOnboardingOf,
  firstRequirementsStatusOf,
  firstRequirementsVenue,
} from './first-requirements.js';

describe('the first-requirements case (project-onboarding req-case, req-result)', () => {
  it('is owed only once every onboarding design is approved', () => {
    expect(firstRequirementsCaseOwed([])).toBe(false);
    expect(
      firstRequirementsCaseOwed([{ designStatus: 'approved' }, { designStatus: 'proposed' }]),
    ).toBe(false);
    expect(firstRequirementsCaseOwed([{ designStatus: null }])).toBe(false);
    expect(
      firstRequirementsCaseOwed([{ designStatus: 'approved' }, { designStatus: 'approved' }]),
    ).toBe(true);
  });

  it('names its onboarding by its venue, and no other room', () => {
    expect(firstRequirementsOnboardingOf(firstRequirementsVenue('o1'))).toBe('o1');
    expect(firstRequirementsOnboardingOf('3f1c')).toBeNull();
    expect(firstRequirementsOnboardingOf(null)).toBeNull();
  });

  it('reads suggested, none or pending', () => {
    expect(firstRequirementsStatusOf({ suggested: 2, baAnswered: true })).toBe('suggested');
    expect(firstRequirementsStatusOf({ suggested: 1, baAnswered: false })).toBe('suggested');
    expect(firstRequirementsStatusOf({ suggested: 0, baAnswered: true })).toBe('none');
    expect(firstRequirementsStatusOf({ suggested: 0, baAnswered: false })).toBe('pending');
  });
});
