// REQ-41 BC-25, BC-27, BC-24: the chat makes the Needs-you decisions the person tells it to, as
// them, on their word in their latest message, and reports each item read back. Fixtures are the
// owner's conversation on dev, 2026-10-22 (a760cd5f): the agreed cluster ISS-603, 606, 608, 609,
// 612-615; "OK, open that cluster for me" then "I said open them for me" (LATEST below); ISS-603, 606 and 608
// already opened by the owner at 07:48 before the model's second turn; and the model's widening to
// ISS-616, 617, 569 and 607, which were never agreed. // i18n-allow: the owner's words quoted

import type { NeedsYouDecision } from '@forge/contracts/needs-you-decisions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RefusalError } from '../../lib/refusal.js';

const answerAs = vi.fn();
const itemStateOf = vi.fn();
vi.mock('../../questions/index.js', () => ({ answerAs: (...a: unknown[]) => answerAs(...a) }));
vi.mock('../item-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../item-state.js')>()),
  itemStateOf: (...a: unknown[]) => itemStateOf(...a),
}));

const { buildDecideToolset, provideNeedsYouDecisionRead, saidInMessage } = await import(
  './decide-tool.js'
);

// the owner's two messages on dev, as they wrote them
const EARLIER = 'Ok mở cho tôi cụm đó đi'; // i18n-allow: the owner's earlier message on dev
const LATEST = 'Tôi bảo là mở giúp tôi đi'; // i18n-allow: the owner's latest message on dev
const WORD = 'mở giúp tôi đi'; // i18n-allow: the owner's word on dev

const PROJECT = 'b9c1e0d4-5a37-4d8e-9a43-1f2a3b4c5d6e';
const OWNER = '6bdd2f2d-96b0-4018-9668-d58ae9f33207';
const qid = (n: number) => `00000000-0000-4000-8000-000000000${n}`;

/** A steward's take-on-or-drop decision on a draft, as Needs you builds it. */
function stewardOpen(seq: number): NeedsYouDecision {
  const path = `/api/questions/${qid(seq)}/answer`;
  const answer = (id: string, label: string, needsReason = false) => ({
    id,
    label,
    act: 'question.answer' as const,
    path,
    body: { round: 1, optionId: id },
    needsReason,
    declines: id === 'steward.drop',
    effect: null,
    recommended: id === 'steward.open',
  });
  return {
    id: `issue:ISS-${seq}:question.answer`,
    group: 'answer',
    area: 'delivery',
    entity: 'issue',
    key: `ISS-${seq}`,
    title: `Draft ${seq}`,
    opens: { kind: 'issue', key: `ISS-${seq}` },
    question: 'Take this draft on, or drop it?',
    recommended: {
      answerId: 'steward.open',
      why: 'It has a requirement and a plan.',
      by: 'steward',
    },
    noRecommendation: null,
    answers: [
      answer('steward.open', 'Open it: admit it for work'),
      answer('steward.drop', 'Drop it', true),
    ],
    touchedAt: '2026-10-22T07:30:00.000Z',
    stuck: false,
    dueAt: null,
    topic: 'issues',
    proposal: null,
  } as unknown as NeedsYouDecision;
}

const repin = {
  ...stewardOpen(700),
  id: 'repin:wf-1',
  key: 'requirement-to-delivery',
  opens: { kind: 'workflow', key: 'requirement-to-delivery' },
  answers: [
    {
      id: 'approve',
      label: 'Approve',
      act: 'workflow.repin',
      path: '/api/projects/x/workflows/wf-1/repin',
      body: {},
      needsReason: false,
      declines: false,
      effect: null,
      recommended: true,
    },
  ],
  recommended: { answerId: 'approve', why: 'Only a pin moves.', by: 'rule' },
} as unknown as NeedsYouDecision;

// what waits on the owner at 07:51, after they opened 603, 606 and 608 themselves at 07:48
let waiting: NeedsYouDecision[] = [];
provideNeedsYouDecisionRead(async () => waiting);

const opened = (key: string, by: string | null, at: string | null) => ({
  key,
  status: 'open',
  movedBy: by,
  movedAt: at,
});

const run = async (latest: string, args: unknown) => {
  const set = buildDecideToolset({
    projectId: PROJECT,
    userId: OWNER,
    latestMessage: () => latest,
  });
  const r = await set.execute('act_on_decisions', JSON.stringify(args));
  const text = (r.content[0] as { text: string }).text;
  return { isError: r.isError === true, body: JSON.parse(text) as Record<string, unknown> };
};

beforeEach(() => {
  answerAs.mockReset().mockResolvedValue({});
  itemStateOf.mockReset().mockImplementation(async (_p: string, item: { key: string }) => {
    if (['ISS-603', 'ISS-606', 'ISS-608'].includes(item.key)) {
      return opened(item.key, 'Darrel', '2026-10-22T07:48:04.924Z');
    }
    if (/^ISS-6\d\d$/.test(item.key)) return opened(item.key, 'Darrel', '2026-10-22T07:52:00.000Z');
    return null;
  });
  waiting = [609, 612, 613, 614, 615, 616, 617].map(stewardOpen).concat(repin);
});

describe("the person's word is in their latest message, or no decision is made (REQ-41 BC-25)", () => {
  it('makes the agreed decisions as the person when their message says to, quoted as they wrote it', async () => {
    const { isError, body } = await run(LATEST, {
      // i18n-allow: the owner's word on dev
      word: WORD, // i18n-allow: the owner's word on dev
      decisions: [{ decision: 'ISS-609' }, { decision: 'issue:ISS-612:question.answer' }],
    });
    expect(isError).toBe(false);
    expect(answerAs).toHaveBeenCalledTimes(2);
    expect(answerAs).toHaveBeenCalledWith({
      questionId: qid(609),
      answer: { kind: 'option', optionId: 'steward.open' },
      round: 1,
      userId: OWNER,
      agency: 'human',
      via: 'assistant',
    });
    expect(body.results).toEqual([
      {
        outcome: 'done',
        decision: 'ISS-609',
        id: 'issue:ISS-609:question.answer',
        answer: 'Open it: admit it for work',
        state: opened('ISS-609', 'Darrel', '2026-10-22T07:52:00.000Z'),
      },
      expect.objectContaining({ outcome: 'done', id: 'issue:ISS-612:question.answer' }),
    ]);
  });

  it('refuses a quote the latest message does not hold, though an earlier one did, and makes none', async () => {
    const { isError, body } = await run(LATEST, {
      // i18n-allow: the owner's word on dev
      word: EARLIER, // i18n-allow: the owner's earlier message, not their latest
      decisions: [{ decision: 'ISS-609' }],
    });
    expect(isError).toBe(true);
    expect(String(body.error)).toMatch(/^CHAT_DECIDE_NO_WORD: /);
    expect(answerAs).not.toHaveBeenCalled();
  });

  it('refuses the model own words dressed as the quote, and a quote with no letter in it', async () => {
    for (const word of ['open them for me', '  ', '!!']) {
      const { isError, body } = await run(LATEST, {
        // i18n-allow: the owner's word on dev
        word,
        decisions: [{ decision: 'ISS-609' }],
      });
      expect(isError).toBe(true);
      expect(String(body.error)).toMatch(/^CHAT_DECIDE_(NO_WORD|INVALID): /);
    }
    expect(answerAs).not.toHaveBeenCalled();
  });

  it('reads case, quote marks and runs of space as the same word, and diacritics as different', () => {
    expect(saidInMessage('“MỞ  giúp tôi”', LATEST)).toBe(true); // i18n-allow: the owner's word on dev
    expect(saidInMessage('mo giup toi', LATEST)).toBe(false); // i18n-allow: the owner's word on dev
  });

  it('refuses arguments that are not the shape, naming the field', async () => {
    const { isError, body } = await run(WORD, { word: WORD, decisions: [] });
    expect(isError).toBe(true);
    expect(String(body.error)).toMatch(/^CHAT_DECIDE_INVALID: decisions: /);
  });
});

describe('an item that needed no act is named done, with who moved it and when (REQ-41 BC-27)', () => {
  it('reports ISS-603, 606 and 608 as already opened by the owner at 07:48, and makes the rest', async () => {
    const { body } = await run(LATEST, {
      // i18n-allow: the owner's word on dev
      word: WORD, // i18n-allow: the owner's word on dev
      decisions: ['ISS-603', 'ISS-606', 'ISS-608', 'ISS-609'].map((decision) => ({ decision })),
    });
    const results = body.results as { outcome: string; decision: string; state: unknown }[];
    expect(results.slice(0, 3)).toEqual(
      ['ISS-603', 'ISS-606', 'ISS-608'].map((key) => ({
        outcome: 'already_done',
        decision: key,
        state: opened(key, 'Darrel', '2026-10-22T07:48:04.924Z'),
      })),
    );
    expect(results[3]?.outcome).toBe('done');
    expect(answerAs).toHaveBeenCalledTimes(1);
    expect(String(body.note)).toContain('Add no item they did not agree to');
  });

  it('refuses by name a key that names no decision and no item, rather than guessing one', async () => {
    const { body } = await run(WORD, {
      // i18n-allow: the owner's word on dev
      word: WORD, // i18n-allow: the owner's word on dev
      decisions: [{ decision: 'ISS-9999' }, { decision: 'the drafts' }],
    });
    expect((body.results as { code: string }[]).map((r) => r.code)).toEqual([
      'DECISION_UNKNOWN',
      'DECISION_UNKNOWN',
    ]);
    expect(answerAs).not.toHaveBeenCalled();
  });
});

describe('a decision is made only as its card would make it, and refused by name otherwise', () => {
  it('leaves a decision that is not a question answer to its card, naming its act', async () => {
    const { body } = await run('approve it for me', {
      word: 'approve it for me',
      decisions: [{ decision: 'repin:wf-1' }],
    });
    expect(body.results).toEqual([
      expect.objectContaining({ outcome: 'refused', code: 'DECISION_ACT_ON_ITS_PAGE' }),
    ]);
    expect(answerAs).not.toHaveBeenCalled();
  });

  it('asks for the reason a drop takes, then sends it as the note', async () => {
    const word = 'drop ISS-616, it duplicates ISS-603';
    const first = await run(word, {
      word,
      decisions: [{ decision: 'ISS-616', answer: 'steward.drop' }],
    });
    expect(first.body.results).toEqual([
      expect.objectContaining({ outcome: 'refused', code: 'DECISION_REASON_REQUIRED' }),
    ]);
    const second = await run(word, {
      word,
      decisions: [{ decision: 'ISS-616', answer: 'steward.drop', reason: 'it duplicates ISS-603' }],
    });
    expect(second.body.results).toEqual([expect.objectContaining({ outcome: 'done' })]);
    expect(answerAs).toHaveBeenCalledWith(
      expect.objectContaining({
        answer: { kind: 'option', optionId: 'steward.drop' },
        note: 'it duplicates ISS-603',
      }),
    );
  });

  it('refuses an answer the decision does not have, and one with no recommendation left out', async () => {
    const bare = {
      ...stewardOpen(620),
      recommended: null,
      noRecommendation: 'The asker gave none.',
    };
    waiting = [...waiting, bare as NeedsYouDecision];
    const { body } = await run('open them', {
      word: 'open them',
      decisions: [{ decision: 'ISS-609', answer: 'steward.merge' }, { decision: 'ISS-620' }],
    });
    expect((body.results as { code: string }[]).map((r) => r.code)).toEqual([
      'DECISION_ANSWER_UNKNOWN',
      'DECISION_NO_RECOMMENDATION',
    ]);
  });

  it('refuses a key that names two decisions, naming both ids', async () => {
    waiting = [...waiting, { ...stewardOpen(609), id: 'issue:ISS-609:steward.second' }];
    const { body } = await run('open them', {
      word: 'open them',
      decisions: [{ decision: 'ISS-609' }],
    });
    const [only] = body.results as { code: string; detail: string }[];
    expect(only?.code).toBe('DECISION_AMBIGUOUS');
    expect(only?.detail).toContain('issue:ISS-609:steward.second');
  });

  it("carries the route's own refusal with the item read back, and goes on to the next", async () => {
    answerAs.mockRejectedValueOnce(
      new RefusalError(
        [
          {
            code: 'QUESTION_ROUND_STALE',
            path: '',
            detail: 'round 1 was answered; round 2 is open',
          },
        ],
        'QUESTION_REFUSED',
      ),
    );
    const { body } = await run('open them', {
      word: 'open them',
      decisions: [{ decision: 'ISS-613' }, { decision: 'ISS-614' }],
    });
    expect(body.results).toEqual([
      expect.objectContaining({
        outcome: 'refused',
        code: 'DECISION_REFUSED',
        detail: expect.stringContaining('QUESTION_ROUND_STALE'),
        state: opened('ISS-613', 'Darrel', '2026-10-22T07:52:00.000Z'),
      }),
      expect.objectContaining({ outcome: 'done', decision: 'ISS-614' }),
    ]);
  });

  it('runs as the person the turn answers, and never as anyone else', () => {
    const set = buildDecideToolset({ projectId: PROJECT, userId: OWNER, latestMessage: () => '' });
    expect(set.ranAs('act_on_decisions')).toBe(OWNER);
  });
});
