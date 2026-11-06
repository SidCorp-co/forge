// ISS-680 c5 (REQ-68 BC-1, each thing said once): a decision that opens a requirement names it in
// its evidence, once, with its key, revision and title, so what Forge itself writes on the decision
// (what is asked of a sign-off, what changes, its impact, what each answer does and why one is
// recommended) calls it "the requirement" and never says its key again. The key stays where it is a
// structure, the decision's `opens` and `key`. A record the decision does not open keeps its key.
// Planted red on dev's builders (db0ee7261): every kind said REQ-74 in its own words again.
//
// @direct-test-of packages/core/src/development/needs-you-named.ts
// @direct-test-of packages/core/src/development/needs-you-decision-builders.ts
// @direct-test-of packages/core/src/development/needs-you-approve-builders.ts
// @direct-test-of packages/core/src/development/needs-you-accept-builders.ts
// @direct-test-of packages/core/src/development/needs-you-escalation.ts

import {
  type NeedsYouDecision,
  needsYouDecisionSchema,
} from '@forge/contracts/needs-you-decisions';
import { stewardMergeOptionId } from '@forge/contracts/steward';
import { describe, expect, it } from 'vitest';
import type { QuestionOption, QuestionStep } from '../db/schema-questions.js';
import type { OpenPersonQuestion } from '../questions/index.js';
import type { AttentionRow } from './needs-you.js';
import { acceptDecision, repinDecision } from './needs-you-accept-builders.js';
import { agreeDecision, revisionDecision } from './needs-you-approve-builders.js';
import { type Built, questionDecision } from './needs-you-decision-builders.js';
import { withEscalation } from './needs-you-escalation.js';
import { breakdownProposal, suggestionProposal } from './needs-you-proposals.js';

const KEY = 'REQ-74';
const P = '11111111-1111-4111-8111-111111111111';
const opens = { kind: 'requirement', key: KEY } as const;

const reqRow = {
  entity: 'requirement',
  key: KEY,
  title: 'Approvals read as one decision each',
  touchedAt: null,
  due: { stuck: false, dueAt: null },
} as unknown as AttentionRow;
const questionRow = { ...reqRow, entity: 'question', key: 'q1', title: 'A question a run asked' };

const option = (id: string, label: string, shares?: string): QuestionOption => ({
  id,
  label,
  authority: 'writer',
  bindsTo: 'this_call',
  executedBy: 'core',
  fingerprint: 'steward:00000000-0000-4000-8000-000000000000:b1',
  ...(shares ? { shares } : {}),
});

function question(
  current: Partial<QuestionStep>,
  over: Partial<OpenPersonQuestion> = {},
): OpenPersonQuestion {
  return {
    id: 'q1',
    issueId: null,
    issueKey: null,
    requirementId: 'r74',
    feedbackId: null,
    aboutFeedback: null,
    subject: { kind: 'requirement', key: KEY, title: 'Approvals read as one decision each' },
    issueItem: null,
    suggestion: null,
    at: '2026-11-01T00:00:00.000Z',
    escalated: null,
    current: {
      round: 1,
      answerShape: 'text',
      askedAt: '2026-11-01T00:00:00.000Z',
      prompt: 'Which row leads the list?',
      needed: '',
      plain: 'Pick which row comes first.',
      ...current,
    } as QuestionStep,
    ...over,
  } as OpenPersonQuestion;
}

const steward = (options: QuestionOption[], over: Partial<OpenPersonQuestion> = {}) =>
  question(
    {
      answerShape: 'choice',
      options,
      recommendedOptionId: options[0]?.id,
      why: 'The steward read the record.',
    } as Partial<QuestionStep>,
    over,
  );

/** What a decision says in Forge's own words: never the asker's question, which is theirs. */
const forgeSaid = (d: NeedsYouDecision, askerWrote: boolean) =>
  [
    ...(askerWrote ? [] : [d.question]),
    d.changes,
    d.impact,
    d.recommended?.by === 'asker' ? null : (d.recommended?.why ?? null),
    d.noRecommendation,
    ...d.answers.flatMap((a) => [a.label, a.effect]),
  ].filter((s): s is string => s !== null);

const drawn = (b: Built) =>
  needsYouDecisionSchema.parse({
    id: 'x',
    stuck: false,
    dueAt: null,
    topic: 'question',
    proposal: null,
    ...b.decision,
  });

const KINDS: [string, () => Built, boolean][] = [
  [
    'a question about the requirement',
    () => questionDecision(questionRow as AttentionRow, 'questions', question({}), opens),
    true,
  ],
  [
    'a question on the requirement',
    () => questionDecision(reqRow, 'requirements', question({}), opens),
    true,
  ],
  [
    'a question on an issue serving it',
    () =>
      questionDecision(
        questionRow as AttentionRow,
        'questions',
        question(
          {},
          {
            requirementId: null,
            issueId: 'i9',
            issueKey: 'ISS-9',
            subject: null,
            issueItem: opens,
          },
        ),
        opens,
      ),
    true,
  ],
  [
    "the steward's withdraw on an agreed requirement",
    () =>
      questionDecision(
        reqRow,
        'requirements',
        steward([option('steward.withdraw', 'Withdraw it'), option('steward.keep', 'Keep it')]),
        opens,
      ),
    false,
  ],
  [
    "the steward's merge or drop of a draft requirement",
    () =>
      questionDecision(
        reqRow,
        'requirements',
        steward([
          option(stewardMergeOptionId('REQ-12'), 'Merge it', 'exporting the call list'),
          option('steward.drop', 'Drop it'),
        ]),
        opens,
      ),
    false,
  ],
  [
    'a revision to accept',
    () => revisionDecision(reqRow, 'requirements', P, 3, 'It reads the new rows.'),
    false,
  ],
  [
    'a requirement to agree',
    () => agreeDecision(reqRow, 'requirements', P, 2, 'It is ready.'),
    false,
  ],
  [
    'a delivery to accept',
    () => acceptDecision(reqRow, 'requirements', P, 2, { passing: 3, total: 3 }),
    false,
  ],
  ['a re-pin', () => repinDecision(reqRow, 'requirements', P, 4), false],
  [
    'a question escalated after 14 days',
    () =>
      withEscalation(
        questionDecision(reqRow, 'requirements', question({}), opens),
        { requirement: { key: KEY, status: 'agreed' } },
        P,
      ),
    true,
  ],
];

describe('a decision opening a requirement names it once, in its evidence (ISS-680 c5)', () => {
  it.each(KINDS)(
    '%s says "the requirement" in its own words, never its key',
    (_, build, askerWrote) => {
      const d = drawn(build());
      expect(d.opens).toEqual(opens);
      const said = forgeSaid(d, askerWrote);
      expect(said.filter((s) => s.includes(KEY))).toEqual([]);
      expect(said.join('\n')).toMatch(/the requirement/i);
    },
  );

  it('keeps the key of a record it does not open: the issue a steward decision moves, the requirement a merge goes into', () => {
    const onIssue = drawn(
      questionDecision(
        questionRow as AttentionRow,
        'questions',
        steward([option('steward.open', 'Open it'), option('steward.drop', 'Drop it')], {
          requirementId: null,
          issueId: 'i9',
          issueKey: 'ISS-9',
          subject: null,
          issueItem: opens,
        }),
        opens,
      ),
    );
    expect(onIssue.changes).toBe('Whether draft ISS-9 becomes open work');
    expect(onIssue.impact).toMatch(/^The requirement waits on this/);
    const merge = drawn(
      questionDecision(
        reqRow,
        'requirements',
        steward([
          option(stewardMergeOptionId('REQ-12'), 'Merge it', 'exporting the call list'),
          option('steward.drop', 'Drop it'),
        ]),
        opens,
      ),
    );
    expect(merge.answers[0]?.effect).toBe(
      'Proposes what the requirement adds as a revision of REQ-12, then drops the requirement, as you. Both are about exporting the call list',
    );
  });

  it('reads whole where the requirement is not named beside it: what changes says which act, on what', () => {
    const d = drawn(revisionDecision(reqRow, 'requirements', P, 3, 'It reads the new rows.'));
    expect(d.question).toBe('Accept revision 3 of the requirement, or return it to its author?');
    expect(d.changes).toBe('Which revision of the requirement is current');
    expect(d.impact).toBe(
      'The requirement waits on this; delivery plans from the current revision.',
    );
  });

  it("calls the requirement a suggestion or a breakdown is on the way the decision's words do", () => {
    const revise = suggestionProposal(
      'revision_diff',
      { reason: 'The rows changed.', changeSummary: 'Adds a stuck row', criteria: [] },
      'the requirement',
    );
    expect(revise.verb).toBe('Revise the requirement');
    const broken = breakdownProposal(
      {
        issues: [
          { title: 'Row', complexity: 's', criteria: [{ body: 'It shows', tracesTo: 'BC-1' }] },
        ],
      },
      { key: KEY, criteria: 2, carriedBy: ['ISS-5'] },
      'the requirement',
    );
    expect(broken.consequences.join('\n')).not.toContain(KEY);
    expect(broken.consequences).toContain(
      'The requirement is already carried by ISS-5; these trace the same criteria again',
    );
  });
});
