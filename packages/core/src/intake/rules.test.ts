// The intake draft judged against what it read (REQ-34 BC-12..BC-16): each rule is planted wrong and
// read back by the fault that names it.

import {
  type IntakeAnswer,
  type IntakeDraftRef,
  intakeAnswerSchema,
} from '@forge/contracts/intake-drafts';
import { describe, expect, it } from 'vitest';
import { type JudgeInput, judgeDraft } from './rules.js';

const known = new Map<string, IntakeDraftRef>([
  ['REQ-1', { kind: 'requirement', key: 'REQ-1', title: 'Referral import' }],
  ['REQ-2', { kind: 'requirement', key: 'REQ-2', title: 'Referral by name' }],
  ['FB-3', { kind: 'feedback', key: 'FB-3', title: 'Import drops the clinic code' }],
  ['workflow:referral', { kind: 'workflow', key: 'referral', title: 'Referral intake' }],
  ['release:1.2.0', { kind: 'release', key: '1.2.0', title: '1.2.0' }],
]);

type Item = JudgeInput['item'];
const requirement: Item = { kind: 'requirement', key: 'REQ-9', title: 'Match referrals' };
const feedbackItem: Item = { kind: 'feedback', key: 'FB-9', title: 'Wrong patient matched' };

const question = {
  prompt: 'Does a referral with no clinic code wait or get rejected?',
  changes: 'outcome' as const,
  options: [
    { id: 'wait', label: 'It waits', effect: 'A clerk matches it by hand' },
    { id: 'reject', label: 'It is rejected', effect: 'The clinic is asked to resend it' },
  ],
  recommended: 'wait',
};

const base: IntakeAnswer = {
  fills: [
    { field: 'summary', value: 'Referrals match patients by clinic code.', source: 'REQ-1' },
    { field: 'criterion', value: 'A referral is matched by clinic code.', source: 'REQ-9' },
  ],
  links: [
    { relation: 'duplicate', ref: 'REQ-1', why: 'Both match referrals by code.' },
    { relation: 'conflict', ref: 'REQ-2', why: 'REQ-2 matches by name.' },
    { relation: 'affected_workflow', ref: 'workflow:referral', why: 'Its match step changes.' },
    { relation: 'related_feedback', ref: 'FB-3', why: 'The same lost code.' },
  ],
  questions: [question],
  nothingToAsk: null,
};

const judge = (
  answer: IntakeAnswer,
  item = requirement,
  triageFault: JudgeInput['triageFault'] = () => null,
) => judgeDraft(answer, { item, known, triageFault });

const faultsOf = (answer: IntakeAnswer, item = requirement) => {
  const out = judge(answer, item);
  return out.ok ? [] : out.faults;
};

describe('an intake draft judged against what it read', () => {
  it('passes a draft whose links, sources and questions all hold, each link and source resolved to its record', () => {
    const out = judge(base);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft.links.map((l) => [l.relation, l.ref.key])).toEqual([
      ['duplicate', 'REQ-1'],
      ['conflict', 'REQ-2'],
      ['affected_workflow', 'referral'],
      ['related_feedback', 'FB-3'],
    ]);
    // the item's own words are a source as much as a record is (BC-13)
    expect(out.draft.assumptions.map((a) => [a.field, a.source.key])).toEqual([
      ['summary', 'REQ-1'],
      ['criterion', 'REQ-9'],
    ]);
  });

  it('refuses a link to a record it was not shown, to the item itself, or of a kind its relation does not take', () => {
    const faults = faultsOf({
      ...base,
      links: [
        { relation: 'related_feedback', ref: 'FB-77', why: 'invented' },
        { relation: 'duplicate', ref: 'REQ-9', why: 'itself' },
        { relation: 'conflict', ref: 'FB-3', why: 'a feedback item is no conflict' },
        { relation: 'duplicate', ref: 'FB-3', why: 'a requirement duplicates a requirement' },
        { relation: 'affected_workflow', ref: 'REQ-1', why: 'not a workflow' },
      ],
    });
    expect(faults).toEqual([
      'links[0].ref "FB-77" is not a ref shown in the record',
      'links[1] links REQ-9 to itself',
      'links[2] names feedback FB-3 as conflict, which links only: requirement',
      'links[3] names feedback FB-3 as duplicate, which links only: requirement',
      'links[4] names requirement REQ-1 as affected_workflow, which links only: workflow',
    ]);
  });

  it('refuses an assumption with no source it read, or on a field the item does not have (BC-13)', () => {
    const faults = faultsOf({
      ...base,
      fills: [
        { field: 'goal', value: 'Faster matching.', source: 'ISS-4' },
        { field: 'severity', value: 'high', source: 'REQ-1' },
      ],
    });
    expect(faults).toEqual([
      'fills[0].source "ISS-4" is not REQ-9 or a ref shown in the record',
      'fills[1].field "severity" is not one of summary, goal, persona, in_scope, out_of_scope, criterion',
    ]);
  });

  it('refuses a recommended answer that is not one of the question’s own options (BC-15)', () => {
    expect(faultsOf({ ...base, questions: [{ ...question, recommended: 'escalate' }] })).toEqual([
      'questions[0].recommended "escalate" is not one of its options (wait, reject)',
    ]);
  });

  it('says it has nothing to ask exactly when it asks nothing (BC-16)', () => {
    expect(faultsOf({ ...base, questions: [], nothingToAsk: null })).toEqual([
      'no question is asked and nothingToAsk is null: say in one line that nothing is worth asking',
    ]);
    expect(faultsOf({ ...base, nothingToAsk: 'Nothing to ask.' })).toEqual([
      'nothingToAsk is set while questions are asked: set it to null',
    ]);
    const quiet = judge({
      ...base,
      questions: [],
      nothingToAsk: 'The record settles every answer.',
    });
    expect(quiet.ok && quiet.draft.questions).toEqual([]);
    expect(quiet.ok && quiet.draft.nothingToAsk).toBe('The record settles every answer.');
  });

  it('takes a feedback draft only with its triage, and a requirement draft only without one', () => {
    const fb: IntakeAnswer = {
      ...base,
      fills: [{ field: 'severity', value: 'high', source: 'FB-9' }],
      links: [{ relation: 'duplicate', ref: 'FB-3', why: 'Same lost code.' }],
    };
    expect(faultsOf(fb, feedbackItem)).toEqual([
      'triage is missing: a feedback draft carries its triage checklist',
    ]);
    const wrong = judge(
      { ...fb, triage: { route: 'nowhere' } },
      feedbackItem,
      () => 'route: invalid',
    );
    expect(wrong.ok ? [] : wrong.faults).toEqual(['triage: route: invalid']);
    expect(judge({ ...fb, triage: { route: 'issue' } }, feedbackItem).ok).toBe(true);
    expect(faultsOf({ ...base, triage: { route: 'issue' } })).toEqual([
      'triage is set on a requirement draft: leave it out',
    ]);
  });
});

describe('the answer shape the model is held to', () => {
  it('takes at most three questions (BC-14)', () => {
    const four = { ...base, questions: [question, question, question, question] };
    const parsed = intakeAnswerSchema.safeParse(four);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['questions']);
    expect(
      intakeAnswerSchema.safeParse({ ...base, questions: [question, question, question] }).success,
    ).toBe(true);
  });

  it('takes a question only when it says whether it changes scope or outcome (BC-14)', () => {
    const vague = { ...question, changes: 'wording' };
    expect(intakeAnswerSchema.safeParse({ ...base, questions: [vague] }).success).toBe(false);
    const { changes: _drop, ...unsaid } = question;
    expect(intakeAnswerSchema.safeParse({ ...base, questions: [unsaid] }).success).toBe(false);
  });

  it('takes an option only with what choosing it changes, and a question only with two to four options (BC-15)', () => {
    const noEffect = {
      ...question,
      options: [{ id: 'wait', label: 'It waits' }, question.options[1]],
    };
    expect(intakeAnswerSchema.safeParse({ ...base, questions: [noEffect] }).success).toBe(false);
    const one = { ...question, options: [question.options[0]] };
    expect(intakeAnswerSchema.safeParse({ ...base, questions: [one] }).success).toBe(false);
  });
});
