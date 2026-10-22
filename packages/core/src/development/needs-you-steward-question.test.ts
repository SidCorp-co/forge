// REQ-48 r3 BC-14 and BC-16 on the steward's question as Needs you draws it, from the round's
// structured fields alone: a round stored before the prompt was one sentence (the ISS-625 round on dev,
// 2026-10-22, its title, "it reads stuck" and the recommendation inside the prompt) reads as the one
// sentence its options make, its reason once from `why`, and a merge naming nothing shared is not
// offered.

import { needsYouDecisionSchema } from '@forge/contracts/needs-you-decisions';
import { describe, expect, it } from 'vitest';
import type { ChoiceStep, QuestionOption } from '../db/schema-questions.js';
import type { OpenPersonQuestion } from '../questions/index.js';
import type { AttentionRow } from './needs-you.js';
import { questionDecision } from './needs-you-decision-builders.js';

const TITLE =
  'Issue criterion BC trace syntax is undocumented; a trailing tag silently traces nothing';
const REASON =
  'ISS-625 now links agreed REQ-48 revision 2 and has a plan and three traced BC-5 criteria, so it is ready for a person to open.';
const row = {
  entity: 'issue',
  key: 'ISS-625',
  title: TITLE,
  touchedAt: null,
} as unknown as AttentionRow;

const option = (id: string, label: string, shares?: string): QuestionOption => ({
  id,
  label,
  authority: 'writer',
  bindsTo: 'this_call',
  executedBy: 'core',
  fingerprint: 'steward:00000000-0000-4000-8000-000000000000:b1',
  ...(shares ? { shares } : {}),
});

function asked(step: Partial<ChoiceStep>): OpenPersonQuestion {
  const current: ChoiceStep = {
    round: 1,
    answerShape: 'choice',
    askedAt: '2026-10-22T11:38:30.455Z',
    prompt: `ISS-625 "${TITLE}": it reads stuck Open it, keep it as a draft, or drop it? Recommended: Open it: admit it for work, because ${REASON}`,
    options: [
      option('steward.open', 'Open it: admit it for work'),
      option(
        'steward.merge:ISS-607',
        'Merge it into ISS-607: Steward re-asks a master for release approvals it cannot give',
      ),
      option('steward.keep', 'Keep it as a draft'),
      option('steward.drop', 'Drop it: it is not work'),
    ],
    recommendedOptionId: 'steward.open',
    why: REASON,
    ...step,
  };
  return {
    id: 'q625',
    issueId: 'i625',
    requirementId: null,
    current,
    at: current.askedAt,
  } as unknown as OpenPersonQuestion;
}

const drawn = (q: OpenPersonQuestion) =>
  needsYouDecisionSchema.parse({
    id: 'x',
    stuck: false,
    dueAt: null,
    topic: 'question',
    proposal: null,
    ...questionDecision(row, 'issues', q, { kind: 'issue', key: 'ISS-625' }).decision,
  });

describe("the steward's question as drawn (REQ-48 r3 BC-14)", () => {
  it('is one plain sentence from its options, never the stored prompt with the title and the recommendation', () => {
    const d = drawn(asked({}));
    expect(d.question).toBe('Open it, keep it as a draft, or drop it?');
    expect(d.question).not.toContain(TITLE);
    expect(d.question).not.toMatch(/Recommended|stuck/);
  });

  it('carries its reason once, as the round recorded it, with no lead repeating the answer', () => {
    const d = drawn(asked({}));
    expect(d.recommended).toEqual({ answerId: 'steward.open', why: REASON, by: 'steward' });
    expect(d.answers.map((a) => a.id)).toEqual(['steward.open', 'steward.keep', 'steward.drop']);
  });
});

describe('a merge offered only where the round names what the two share (REQ-48 r3 BC-16)', () => {
  it('shows a merge that names it, saying so on its effect', () => {
    const d = drawn(
      asked({
        options: [
          option('steward.open', 'Open it: admit it for work'),
          option(
            'steward.merge:ISS-630',
            'Merge it into ISS-630',
            'the BC trace syntax of criteria.',
          ),
        ],
      }),
    );
    expect(d.question).toBe('Open it or merge it into ISS-630?');
    expect(d.answers[1]?.effect).toBe(
      "Copies ISS-625's text to ISS-630 as a comment, then drops ISS-625, as you. Both are about the BC trace syntax of criteria.",
    );
  });

  it('recommends none where its recommended merge named nothing, and offers the rest', () => {
    const d = drawn(asked({ recommendedOptionId: 'steward.merge:ISS-607' }));
    expect(d.recommended).toBeNull();
    expect(d.noRecommendation).toContain('without naming what the two share');
    expect(d.answers.map((a) => a.id)).toEqual(['steward.open', 'steward.keep', 'steward.drop']);
  });
});
