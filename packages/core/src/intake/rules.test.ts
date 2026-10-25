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
  blocks: null,
};

const value: IntakeAnswer['value'] = {
  who: { value: 'Clinic clerks booking referrals', source: 'REQ-9' },
  improves: { value: 'Each referral reaches its own patient', source: 'REQ-9' },
  measured: { value: 'Referrals matched by clinic code', source: 'REQ-1' },
  exists: null,
  outcome: { kind: 'accept' },
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
  value,
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
      value: {
        ...value,
        who: { value: 'Clerks importing referrals', source: 'FB-9' },
        improves: { value: 'The right patient is matched', source: 'FB-9' },
      },
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

describe('the value check judged against what it read (REQ-65 BC-2..BC-5)', () => {
  const blocking = (blocks: 'problem' | 'value' | 'criterion') => ({ ...question, blocks });
  const withValue = (v: Partial<IntakeAnswer['value']>, rest: Partial<IntakeAnswer> = {}) =>
    faultsOf({ ...base, ...rest, value: { ...value, ...v } });

  it('resolves each fact to the item, a record shown, or a question’s recommended answer as offered', () => {
    const out = judge({
      ...base,
      value: { ...value, measured: { value: 'model words', source: 'question:1' } },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft.value.who?.source).toEqual({
      kind: 'requirement',
      key: 'REQ-9',
      title: 'Match referrals',
    });
    expect(out.draft.value.measured).toEqual({
      value: 'It waits',
      source: { kind: 'recommended', question: 1 },
    });
    expect(out.draft.value.outcome).toEqual({ kind: 'accept' });
  });

  it('refuses a fact sourced from nothing read, a question not asked, or a question that blocks', () => {
    expect(withValue({ measured: { value: 'x', source: 'ISS-4' } })).toEqual([
      'value.measured.source "ISS-4" is not REQ-9, a ref shown in the record, or question:N',
    ]);
    expect(withValue({ measured: { value: 'x', source: 'question:3' } })).toEqual([
      'value.measured.source "question:3" names no question: 1 are asked',
    ]);
    expect(
      withValue(
        { who: null, measured: { value: 'x', source: 'question:1' }, outcome: null },
        { questions: [blocking('problem')] },
      ),
    ).toEqual([
      'value.measured.source "question:1" is a question that blocks the check: a blocking question\'s answer is waited for, never assumed',
    ]);
  });

  it('merges only into the duplicate it links, and never accepts what already exists', () => {
    const exists = { ref: 'REQ-1', why: 'Same clinic-code match.' };
    expect(withValue({ exists })).toEqual([
      'value.outcome accepts REQ-9, which repeats REQ-1: merge into it, offer a better alternative, or refuse',
    ]);
    expect(withValue({ exists, outcome: { kind: 'merge', into: 'REQ-2', why: 'x' } })).toEqual([
      'value.outcome merges into REQ-2, which is not what value.exists names: a merge joins the item it repeats',
    ]);
    expect(withValue({ exists: { ref: 'REQ-2', why: 'x' }, outcome: null })).toContain(
      'value.exists names REQ-2, which no duplicate link that stands names: link it as a duplicate with its basis, or set exists to null',
    );
    const merged = judge({
      ...base,
      value: {
        ...value,
        exists,
        outcome: { kind: 'merge', into: 'REQ-1', why: 'One match rule.' },
      },
    });
    expect(merged.ok && merged.draft.value.outcome).toEqual({
      kind: 'merge',
      into: { kind: 'requirement', key: 'REQ-1', title: 'Referral import' },
      why: 'One match rule.',
    });
  });

  it('blocks only on a missing problem or value, or a criterion a conflict link quotes (BC-4)', () => {
    expect(withValue({ outcome: null }, { questions: [blocking('problem')] })).toEqual([
      'questions[0] blocks on the problem, which value.who states: a question blocks only on what is missing',
    ]);
    expect(withValue({ outcome: null }, { questions: [blocking('value')] })).toEqual([
      'questions[0] blocks on the value, which value.improves states: a question blocks only on what is missing',
    ]);
    // with REQ-2's conflict link gone, no criterion the item contradicts can hold the check
    const noConflict = base.links.filter((l) => l.relation !== 'conflict');
    expect(
      withValue({ outcome: null }, { links: noConflict, questions: [blocking('criterion')] }),
    ).toEqual([
      'questions[0] blocks on a criterion, but no conflict link that stands quotes one: link the criterion it contradicts, or let it not block',
    ]);
    // REQ-2's link quotes its BC-1 word for word, so that criterion holds the check
    expect(withValue({ outcome: null }, { questions: [blocking('criterion')] })).toEqual([]);
    const held = judge({
      ...base,
      questions: [blocking('problem')],
      value: { ...value, who: null, outcome: null },
    });
    expect(held.ok && held.draft.value.outcome).toBeNull();
  });

  it('asks or refuses a missing problem or value, and never leaves the measure unfilled (BC-4, BC-5)', () => {
    expect(withValue({ who: null })).toEqual([
      'value.who is null: ask whose problem it is in a question that blocks on "problem", or refuse the request for naming nobody',
    ]);
    expect(withValue({ improves: null })).toEqual([
      'value.improves is null: ask what improves in a question that blocks on "value", or refuse the request for giving nothing',
    ]);
    expect(
      withValue({ who: null, outcome: { kind: 'refuse', reason: 'It names nobody.' } }),
    ).toEqual([]);
    expect(withValue({ measured: null })).toEqual([
      'value.measured is null, a gap that does not block: fill it from the record, or ask a question and name it as the source (question:N) so its recommended answer is taken',
    ]);
  });

  it('ends the check exactly when no question holds it', () => {
    expect(withValue({ outcome: null })).toEqual([
      'value.outcome is null while no question blocks: end the check as accept, merge, alternative or refuse',
    ]);
    expect(withValue({ who: null }, { questions: [blocking('problem')] })).toEqual([
      'a question blocks the check, so value.outcome is null until it is answered',
    ]);
  });

  it('has a feedback triage follow the check, and proposes none while it is held (REQ-66 BC-2)', () => {
    const fbValue = {
      ...value,
      who: { value: 'Clerks', source: 'FB-9' },
      improves: { value: 'The right patient', source: 'FB-9' },
    };
    const fb = (v: Partial<IntakeAnswer['value']>, triage: unknown, questions = base.questions) => {
      const out = judge(
        {
          ...base,
          fills: [{ field: 'severity', value: 'high', source: 'FB-9' }],
          links: [],
          questions,
          value: { ...fbValue, ...v },
          triage,
        },
        feedbackItem,
      );
      return out.ok ? out : out.faults;
    };
    expect(
      fb({ outcome: { kind: 'refuse', reason: 'Not a problem.' } }, { route: 'issue' }),
    ).toEqual([
      'value.outcome refuses the item, so triage.route is "decline", its note the reason',
    ]);
    expect(fb({}, { route: 'decline' })).toEqual([
      'value.outcome is accept, so triage neither declines nor routes as a duplicate',
    ]);
    const held = fb({ who: null, outcome: null }, undefined, [blocking('problem')]);
    expect(!Array.isArray(held) && held.draft.triage).toBeUndefined();
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
