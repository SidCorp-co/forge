// REQ-68 BC-1, judged red on 0.4.0-dev.325 (K98, ISS-673): a run's free-text question listed the
// choices it weighed only in what its answer needs, and the decision carried that need only in the
// typed button's effect, cut at 200 characters mid-word and drawn on the Needs you card as a hover
// title, so on a phone the options were not shown at all. The need is the question's own, whole.

import { needsYouDecisionSchema } from '@forge/contracts/needs-you-decisions';
import { describe, expect, it } from 'vitest';
import type { OpenPersonQuestion } from '../questions/index.js';
import type { AttentionRow } from './needs-you.js';
import { clipAtWord, questionDecision } from './needs-you-decision-builders.js';

const row = {
  entity: 'issue',
  key: 'ISS-673',
  title: 'Trace advice',
  touchedAt: null,
} as unknown as AttentionRow;

// ISS-673's shape: the options live in `needed`, longer than the 200 characters the effect kept
const NEEDED =
  'Which of two ways on: a second fix round on c1, where the trace advice on the wrong branch is rewritten and re-judged, or accept c1 as it stands, since the advice is right on every branch a person reads and only the internal one is off.';

const question = (over: Record<string, unknown>) =>
  ({
    id: '8f6162f9-0000-4000-8000-000000000673',
    issueId: '00000000-0000-4000-8000-000000000673',
    requirementId: null,
    feedbackId: null,
    aboutFeedback: null,
    subject: null,
    at: '2026-10-25T09:00:00.000Z',
    escalated: null,
    suggestion: null,
    current: {
      round: 1,
      answerShape: 'free_text',
      askedAt: '2026-10-25T09:00:00.000Z',
      prompt: 'The judge failed c1 of ISS-673. How should the run go on?',
      needed: NEEDED,
      ...over,
    },
  }) as unknown as OpenPersonQuestion;

const served = (q: OpenPersonQuestion) =>
  needsYouDecisionSchema.parse({
    id: 'x',
    stuck: false,
    dueAt: null,
    topic: 'question',
    proposal: null,
    ...questionDecision(row, 'issues', q, { kind: 'issue', key: 'ISS-673' }).decision,
  });

describe("a free-text round's decision states the asker's options in its question", () => {
  it('carries the whole need, once, and no button carries it', () => {
    const d = served(question({}));
    expect(d.question).toBe(
      `The judge failed c1 of ISS-673. How should the run go on?\n\nWhat answers it: ${NEEDED}`,
    );
    expect(JSON.stringify(d).split('a second fix round on c1')).toHaveLength(2);
    for (const a of d.answers) expect(a.effect ?? '').not.toContain('fix round');
  });

  it('says it with a recommendation too, which stays the button it sends', () => {
    const d = served(question({ recommended: 'Accept c1 as it stands.' }));
    expect(d.question).toContain(NEEDED);
    expect(d.recommended?.answerId).toBe('recommended');
    expect(d.answers.map((a) => a.id)).toEqual(['recommended', 'write']);
  });

  it('keeps a need far past the room whole to its last word, and the question within its bound', () => {
    const long = `${NEEDED} `.repeat(12).trim();
    const d = served(question({ needed: long }));
    expect(d.question.length).toBeLessThanOrEqual(2000);
    const need = d.question.split('What answers it: ')[1] ?? '';
    expect(need.endsWith('…')).toBe(true);
    // cut where a word ends: the text before the mark is a prefix ending on a whole word of the need
    const kept = need.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long.charAt(kept.length)).toBe(' ');
  });
});

describe('clipAtWord', () => {
  it('leaves short text alone and never cuts inside a word', () => {
    expect(clipAtWord('a short line', 50)).toBe('a short line');
    expect(clipAtWord('alpha beta gamma delta', 13)).toBe('alpha beta…');
    expect(clipAtWord('averyveryverylongword', 8)).toBe('averyve…');
  });
});
