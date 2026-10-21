// REQ-10 r4 BC-6 and BC-11 as pure rules: a round asks at most three recommended questions, what the
// code suggests is an assumption, a recommendation is a suggestion, and done waits on no draft.

import type { QuestionnaireItem } from '@forge/contracts/onboarding';
import { describe, expect, it } from 'vitest';
import { itemRefusals } from '../questionnaires/rules.js';
import { designsUnproposedRefusal, onboardingItemRefusals } from './rules.js';

const item = (id: string, over: Partial<QuestionnaireItem> = {}): QuestionnaireItem => ({
  id,
  group: 'question',
  control: 'choice',
  prompt: `Which reading holds for ${id}?`,
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
  inferredDefault: 'yes',
  why: 'The designs differ.',
  evidence: ['src/a.ts:A'],
  affects: [],
  ...over,
});
const codes = (items: QuestionnaireItem[]) => onboardingItemRefusals(items).map((r) => r.code);

describe('onboardingItemRefusals', () => {
  it('takes three recommended questions and any number of assumptions', () => {
    const assumptions = Array.from({ length: 10 }, (_, i) =>
      item(`a${i}`, { group: 'assumption' }),
    );
    expect(
      codes([item('q1'), item('q2', { group: 'clarification' }), item('q3'), ...assumptions]),
    ).toEqual([]);
  });

  it('refuses a fourth question or clarification once, naming the cap and the items', () => {
    const r = onboardingItemRefusals([
      item('q1'),
      item('q2'),
      item('q3', { group: 'clarification' }),
      item('q4'),
    ]);
    expect(r.map((x) => x.code)).toEqual(['ONBOARDING_QUESTIONS_OVER_CAP']);
    expect(r[0]?.detail).toContain('at most 3 questions; this one asks 4 (q1, q2, q3, q4)');
  });

  it('refuses a recommendation item: it lands as a suggestion on its own', () => {
    expect(
      codes([
        item('r1', {
          group: 'recommendation',
          control: 'accept_reject',
          options: [],
          inferredDefault: undefined,
        }),
      ]),
    ).toEqual(['ONBOARDING_RECOMMENDATION_IS_A_SUGGESTION']);
  });

  it('refuses a question with no recommended answer, and an open-text one', () => {
    expect(
      codes([
        item('q1', { inferredDefault: undefined }),
        item('q2', { control: 'text', options: [], inferredDefault: undefined }),
      ]),
    ).toEqual(['ONBOARDING_QUESTION_UNRECOMMENDED', 'ONBOARDING_QUESTION_UNRECOMMENDED']);
  });
});

describe('itemRefusals: an assumption names the option the code suggests', () => {
  it('takes a choice assumption with its suggested option', () => {
    expect(itemRefusals([item('a1', { group: 'assumption' })])).toEqual([]);
  });

  it('refuses one with no suggested option, or one that is not a choice', () => {
    const r = itemRefusals([
      item('a1', { group: 'assumption', inferredDefault: undefined }),
      item('a2', { group: 'assumption', control: 'multi' }),
    ]);
    expect(r.map((x) => [x.code, x.path])).toEqual([
      ['QUESTIONNAIRE_ITEM_INVALID', '/items/0/inferredDefault'],
      ['QUESTIONNAIRE_ITEM_INVALID', '/items/1/inferredDefault'],
    ]);
  });
});

describe('designsUnproposedRefusal', () => {
  const d = (flow: string, designStatus: string | null) => ({
    workflowId: `w-${flow}`,
    flow,
    designStatus,
  });

  it('lets done through once every design is proposed or decided', () => {
    expect(
      designsUnproposedRefusal([d('a', 'proposed'), d('b', 'approved'), d('c', 'returned')]),
    ).toBeNull();
  });

  it('names every design still at draft', () => {
    const r = designsUnproposedRefusal([d('a', 'proposed'), d('b', 'draft'), d('c', null)]);
    expect(r?.code).toBe('ONBOARDING_DESIGNS_UNPROPOSED');
    expect(r?.detail).toContain('b (w-b), c (w-c) still stand at draft');
  });
});
