import { describe, expect, it } from 'vitest';
import { batchReopensRoom, questionnaireArmRefusal } from './rules.js';

const arm = (
  onboardingId: string | null,
  requirementId: string | null,
  firstRequirementsOf: string | null,
) => ({ onboardingId, requirementId, firstRequirementsOf });

describe('a questionnaire batch belongs to exactly one thread', () => {
  it('is an onboarding round, a requirement ask or a first-requirements ask', () => {
    expect(questionnaireArmRefusal(arm('o', null, null))).toBeNull();
    expect(questionnaireArmRefusal(arm(null, 'r', null))).toBeNull();
    expect(questionnaireArmRefusal(arm(null, null, 'o'))).toBeNull();
  });

  it('refuses none, or two, by name', () => {
    expect(questionnaireArmRefusal(arm(null, null, null))?.code).toBe(
      'QUESTIONNAIRE_THREAD_INVALID',
    );
    expect(questionnaireArmRefusal(arm('o', null, 'o'))?.code).toBe('QUESTIONNAIRE_THREAD_INVALID');
  });

  it('hands the answers to the BA in its room, never to the onboarding job', () => {
    expect(batchReopensRoom(arm('o', null, null))).toBe(false);
    expect(batchReopensRoom(arm(null, 'r', null))).toBe(true);
    expect(batchReopensRoom(arm(null, null, 'o'))).toBe(true);
  });
});
