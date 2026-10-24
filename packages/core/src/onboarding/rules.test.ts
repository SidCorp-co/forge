// REQ-10 r4 BC-2, BC-6 and BC-11 as pure rules: start and re-analysis are a person's ask, a round asks
// at most three recommended questions, what the code suggests is an assumption, a recommendation is a
// suggestion, and done waits on no draft.

import type { QuestionnaireItem } from '@forge/contracts/onboarding';
import { describe, expect, it } from 'vitest';
import { itemRefusals } from '../questionnaires/rules.js';
import {
  designsUnproposedRefusal,
  onboardingItemRefusals,
  onboardingStatusOf,
  personActRefusal,
} from './rules.js';

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

describe("personActRefusal: start and re-analysis are a person's ask (BC-2)", () => {
  const projectId = '00000000-0000-4000-8000-000000000001';
  const admin = { projectId, role: 'admin' as const, grants: [] };
  const viewer = { projectId, role: 'viewer' as const, grants: [] };

  it('refuses an agent by name though its role holds onboarding.request', () => {
    const r = personActRefusal('agent', admin, 'asking for a re-analysis');
    expect(r?.code).toBe('ONBOARDING_PERSON_ACT_FORBIDDEN');
    expect(r?.detail).toContain("asking for a re-analysis is a person's ask (REQ-10 BC-2)");
    expect(r?.detail).toContain('A person of the project holding onboarding.request asks for it');
  });

  it('refuses an agent by name before the permission it lacks', () => {
    expect(personActRefusal('agent', viewer, 'starting onboarding')?.code).toBe(
      'ONBOARDING_PERSON_ACT_FORBIDDEN',
    );
  });

  it('lets a person holding onboarding.request ask, and refuses one without it the permission', () => {
    expect(personActRefusal('human', admin, 'asking for a re-analysis')).toBeNull();
    expect(personActRefusal('human', viewer, 'starting onboarding')?.code).toBe(
      'PERMISSION_FORBIDDEN',
    );
  });
});

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

describe('onboardingStatusOf: a failed analysis never reads done and waits on no answer (BC-11, ISS-605)', () => {
  const done = { doneAt: new Date('2026-10-01T00:00:00Z') };
  const open = { doneAt: null };

  it('reads failed when the newest attempt failed, done or not, open question or not', () => {
    expect(onboardingStatusOf(done, false, 'failed')).toBe('failed');
    expect(onboardingStatusOf(done, true, 'failed')).toBe('failed');
    expect(onboardingStatusOf(open, true, 'failed')).toBe('failed');
    expect(onboardingStatusOf(open, false, 'failed')).toBe('failed');
  });

  it('reads a live retry, a settled or a cancelled job as before: only a failure with nothing after it is one', () => {
    for (const s of ['queued', 'dispatched', 'held', 'done', 'cancelled', null]) {
      expect(onboardingStatusOf(done, true, s)).toBe('done');
      expect(onboardingStatusOf(open, true, s)).toBe('waiting_on_you');
      expect(onboardingStatusOf(open, false, s)).toBe('in_progress');
    }
  });
});
