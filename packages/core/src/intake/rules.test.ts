// The intake draft judged against what it read (REQ-34 BC-12..BC-16): each rule is planted wrong and
// read back by the fault that names it.

import { type IntakeAnswer, intakeAnswerSchema } from '@forge/contracts/intake-drafts';
import { describe, expect, it } from 'vitest';
import { type JudgeInput, judgeDraft, type ShownRecord, workflowsTouched } from './rules.js';

const shown: ShownRecord[] = [
  {
    kind: 'requirement',
    key: 'REQ-1',
    title: 'Referral import',
    lines: ['REQ-1 (agreed): Referral import', '  In short: Referrals are matched by clinic code.'],
    criteria: [{ code: 'BC-1', text: 'A referral is matched by its clinic code.' }],
  },
  {
    kind: 'requirement',
    key: 'REQ-2',
    title: 'Referral by name',
    lines: [
      'REQ-2 (agreed): Referral by name',
      '  BC-1: A referral is matched by the patient name.',
    ],
    criteria: [{ code: 'BC-1', text: 'A referral is matched by the patient name.' }],
  },
  {
    kind: 'feedback',
    key: 'FB-3',
    title: 'Import drops the clinic code',
    lines: ['FB-3 (bug, high, new): Import drops the clinic code'],
  },
  {
    kind: 'workflow',
    key: 'referral',
    title: 'Referral intake',
    lines: [
      'workflow:referral (Referral intake, approved r2)',
      '  Steps: Match the referral; Book it',
    ],
    steps: ['Match the referral', 'Book it'],
  },
  { kind: 'release', key: '1.2.0', title: '1.2.0', lines: ['release:1.2.0'] },
];
const known = new Map<string, ShownRecord>(
  shown.map((r) => [
    r.kind === 'workflow' || r.kind === 'release' ? `${r.kind}:${r.key}` : r.key,
    r,
  ]),
);

type Item = JudgeInput['item'];
const requirement: Item = {
  kind: 'requirement',
  key: 'REQ-9',
  title: 'Match referrals',
  lines: ['Title: Match referrals', 'Goal: Match each referral to its patient by clinic code.'],
};
const feedbackItem: Item = {
  kind: 'feedback',
  key: 'FB-9',
  title: 'Wrong patient matched',
  lines: [
    'Title: Wrong patient matched',
    'Kind given: bug; severity given: high',
    'About: REQ-1',
    'Body: The import matched the wrong patient because the clinic code was dropped.',
  ],
};
const said = 'Match each referral to its patient';

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
    {
      relation: 'duplicate',
      ref: 'REQ-1',
      why: 'Both match referrals by code.',
      basis: 'Referrals are matched by clinic code',
      itemQuote: said,
    },
    {
      relation: 'conflict',
      ref: 'REQ-2',
      why: 'REQ-2 BC-1 matches by name.',
      basis: 'matched by the patient name',
      itemQuote: 'its patient by clinic code',
    },
    {
      relation: 'affected_workflow',
      ref: 'workflow:referral',
      why: 'Its match step changes.',
      basis: 'Match the referral',
      itemQuote: said,
    },
    {
      relation: 'related_feedback',
      ref: 'FB-3',
      why: 'The same lost code.',
      basis: 'drops the clinic code',
      itemQuote: 'its patient by clinic code',
    },
  ],
  notAffected: [],
  questions: [question],
  nothingToAsk: null,
};

const judge = (
  answer: IntakeAnswer,
  item = requirement,
  triageFault: JudgeInput['triageFault'] = () => null,
  touched: readonly string[] = [],
) => judgeDraft(answer, { item, known, touched, triageFault });

const faultsOf = (answer: IntakeAnswer, item = requirement, touched: readonly string[] = []) => {
  const out = judge(answer, item, () => null, touched);
  return out.ok ? [] : out.faults;
};

const link = (
  relation: IntakeAnswer['links'][number]['relation'],
  ref: string,
  why = 'a line',
  basis = 'Referrals are matched by clinic code',
  itemQuote = said,
) => ({ relation, ref, why, basis, itemQuote });

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
        link('related_feedback', 'FB-77', 'invented'),
        link('duplicate', 'REQ-9', 'itself'),
        link('conflict', 'FB-3', 'a feedback item is no conflict'),
        link('duplicate', 'FB-3', 'a requirement duplicates a requirement'),
        link('affected_workflow', 'REQ-1', 'not a workflow'),
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
      links: [
        link(
          'duplicate',
          'FB-3',
          'Same lost code.',
          'drops the clinic code',
          'the clinic code was dropped',
        ),
      ],
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

describe('the workflows an item touches, which the draft must name or set aside', () => {
  const workflows = [
    { ref: 'workflow:feedback-triage', title: 'Feedback triage' },
    { ref: 'workflow:feedback-lifecycle', title: 'Feedback lifecycle' },
    { ref: 'workflow:onboarding', title: 'Project onboarding' },
  ];

  it('offers the one it was filed against first, then those whose title shares the item’s words', () => {
    const item = {
      lines: ['Title: Triaging a bug should need three answers', 'About: workflow:onboarding'],
      workflowRef: 'workflow:onboarding',
    };
    expect(workflowsTouched(item, workflows)).toEqual([
      'workflow:onboarding',
      'workflow:feedback-triage',
    ]);
  });

  it('reads no subject from a generic word, nor from the kind and target core wrote beside the item', () => {
    const item = {
      lines: ['Title: The lifecycle view is slow', 'Kind given: bug; severity given: feedback'],
    };
    expect(workflowsTouched(item, workflows)).toEqual([]);
  });
});
