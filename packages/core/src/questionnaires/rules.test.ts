import type { QuestionnaireItem } from '@forge/contracts/onboarding';
import { describe, expect, it } from 'vitest';
import {
  alreadyOpenRefusal,
  answerRefusals,
  type BatchState,
  itemRefusals,
  posterRefusal,
  repeatRefusals,
  roundsRefusal,
  submitStateRefusal,
  submitterRefusal,
} from './rules.js';

const choice: QuestionnaireItem = {
  id: 'q1',
  group: 'question',
  control: 'choice',
  prompt: 'Which entity is central?',
  options: [
    { id: 'followup', label: 'FollowUp' },
    { id: 'patient', label: 'Patient' },
  ],
  inferredDefault: 'followup',
  why: 'The state machine is drawn for it.',
  evidence: ['apps/api/src/followup/followup.entity.ts:FollowUp'],
  affects: [],
};
const text: QuestionnaireItem = {
  id: 'c1',
  group: 'clarification',
  control: 'text',
  prompt: 'What does Paused mean?',
  why: 'No code moves into it.',
  evidence: ['REQ-12 BC-6'],
  affects: [],
};
const rec: QuestionnaireItem = {
  id: 'r1',
  group: 'recommendation',
  control: 'accept_reject',
  prompt: 'Mark the project sensitive.',
  why: 'Patient holds a diagnosis.',
  evidence: ['prisma/schema.prisma:Patient'],
  affects: [],
};
const multi: QuestionnaireItem = {
  ...choice,
  id: 'm1',
  control: 'multi',
  inferredDefault: undefined,
} as QuestionnaireItem;

const codes = (rs: { code: string }[]) => rs.map((r) => r.code);

describe('questionnaire guards (project-onboarding rule ask)', () => {
  it('a well-formed batch passes', () => {
    expect(itemRefusals([choice, text, rec])).toEqual([]);
  });

  it('QUESTIONNAIRE_ITEM_INVALID: a repeated id, a lone option, a default outside the options, a recommendation not accept_reject, evidence that cites nothing', () => {
    expect(codes(itemRefusals([choice, { ...choice }]))).toEqual(['QUESTIONNAIRE_ITEM_INVALID']);
    expect(
      itemRefusals([{ ...choice, options: [{ id: 'a', label: 'A' }], inferredDefault: 'a' }])[0]
        ?.path,
    ).toBe('/items/0/options');
    expect(itemRefusals([{ ...choice, inferredDefault: 'nope' }])[0]?.path).toBe(
      '/items/0/inferredDefault',
    );
    expect(itemRefusals([{ ...rec, control: 'choice', options: choice.options }])[0]?.path).toBe(
      '/items/0/control',
    );
    expect(itemRefusals([{ ...text, options: choice.options }])[0]?.path).toBe('/items/0/options');
    expect(itemRefusals([{ ...text, evidence: ['because I think so'] }])[0]?.path).toBe(
      '/items/0/evidence/0',
    );
  });

  it('QUESTIONNAIRE_ITEM_ANSWERED_BEFORE and QUESTIONNAIRE_RECOMMENDATION_REJECTED: a follow-up carries only what stayed open', () => {
    expect(repeatRefusals([choice, rec], new Set(), new Set())).toEqual([]);
    expect(codes(repeatRefusals([choice], new Set(['q1']), new Set()))).toEqual([
      'QUESTIONNAIRE_ITEM_ANSWERED_BEFORE',
    ]);
    expect(codes(repeatRefusals([rec], new Set(['r1']), new Set(['r1'])))).toEqual([
      'QUESTIONNAIRE_RECOMMENDATION_REJECTED',
    ]);
  });

  it('QUESTIONNAIRE_ROUNDS_EXHAUSTED: no fourth round', () => {
    expect(roundsRefusal(2)).toBeNull();
    expect(roundsRefusal(3)?.code).toBe('QUESTIONNAIRE_ROUNDS_EXHAUSTED');
  });

  it('QUESTIONNAIRE_ALREADY_OPEN: one open batch per thread, a skipped one included', () => {
    expect(alreadyOpenRefusal(null)).toBeNull();
    expect(alreadyOpenRefusal({ id: 'b1', round: 1, status: 'skipped' })?.code).toBe(
      'QUESTIONNAIRE_ALREADY_OPEN',
    );
  });

  const batch: BatchState = {
    id: 'b1',
    status: 'open',
    round: 1,
    submittedAt: null,
    supersededAt: null,
    supersededReason: null,
    supersededBy: null,
  };

  it('QUESTIONNAIRE_SUPERSEDED names the batch that replaced it; QUESTIONNAIRE_ALREADY_ANSWERED refuses a second send', () => {
    expect(submitStateRefusal(batch, false)).toBeNull();
    expect(submitStateRefusal({ ...batch, status: 'skipped' }, false)).toBeNull();
    const superseded = submitStateRefusal(
      {
        ...batch,
        status: 'superseded',
        supersededAt: new Date(0),
        supersededBy: 'b2',
        supersededReason: 'superseded by re-analysis',
      },
      false,
    );
    expect(superseded?.code).toBe('QUESTIONNAIRE_SUPERSEDED');
    expect(superseded?.detail).toContain('b2');
    expect(
      submitStateRefusal({ ...batch, status: 'submitted', submittedAt: new Date(0) }, false)?.code,
    ).toBe('QUESTIONNAIRE_ALREADY_ANSWERED');
  });

  const items = new Map([
    ['q1', { item: choice, open: true }],
    ['c1', { item: text, open: true }],
    ['r1', { item: rec, open: true }],
    ['m1', { item: multi, open: true }],
  ]);

  it('a partial send is accepted: the answered items fit, the rest stay open', () => {
    expect(answerRefusals(items, [{ itemId: 'q1', choice: 'patient' }], false)).toEqual([]);
    expect(
      answerRefusals(
        items,
        [
          { itemId: 'm1', choices: ['followup', 'patient'] },
          { itemId: 'r1', decision: 'reject' },
        ],
        false,
      ),
    ).toEqual([]);
  });

  it('QUESTIONNAIRE_NOTHING_ANSWERED, QUESTIONNAIRE_ITEM_UNKNOWN, QUESTIONNAIRE_ANSWER_INVALID', () => {
    expect(codes(answerRefusals(items, [], false))).toEqual(['QUESTIONNAIRE_NOTHING_ANSWERED']);
    expect(answerRefusals(items, [], true)).toEqual([]);
    expect(codes(answerRefusals(items, [{ itemId: 'zz', text: 'x' }], false))).toEqual([
      'QUESTIONNAIRE_ITEM_UNKNOWN',
    ]);
    expect(codes(answerRefusals(items, [{ itemId: 'q1', choice: 'nope' }], false))).toEqual([
      'QUESTIONNAIRE_ANSWER_INVALID',
    ]);
    expect(codes(answerRefusals(items, [{ itemId: 'c1', choice: 'followup' }], false))).toEqual([
      'QUESTIONNAIRE_ANSWER_INVALID',
    ]);
    expect(
      codes(
        answerRefusals(
          items,
          [
            { itemId: 'q1', choice: 'patient' },
            { itemId: 'q1', choice: 'patient' },
          ],
          false,
        ),
      ),
    ).toEqual(['QUESTIONNAIRE_ANSWER_INVALID']);
  });

  it('QUESTIONNAIRE_SUBMIT_FORBIDDEN for an agent; QUESTIONNAIRE_POST_FORBIDDEN for a person', () => {
    expect(submitterRefusal({ userId: 'u', agency: 'human', role: 'member' }, 'p')).toBeNull();
    expect(submitterRefusal({ userId: 'u', agency: 'agent', role: 'member' }, 'p')?.code).toBe(
      'QUESTIONNAIRE_SUBMIT_FORBIDDEN',
    );
    expect(submitterRefusal({ userId: 'u', agency: 'human', role: 'viewer' }, 'p')?.code).toBe(
      'QUESTIONNAIRE_SUBMIT_FORBIDDEN',
    );
    expect(posterRefusal({ userId: 'a', agency: 'agent', role: 'member' }, 'p')).toBeNull();
    expect(posterRefusal({ userId: 'u', agency: 'human', role: 'admin' }, 'p')?.code).toBe(
      'QUESTIONNAIRE_POST_FORBIDDEN',
    );
  });
});
