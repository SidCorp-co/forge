// REQ-41 BC-25, BC-27, BC-24: the chat makes the Needs-you decisions the person tells it to, as
// them, on their word in their latest message, and reports each item read back. Fixtures are the
// owner's conversation on dev, 2026-10-22 (a760cd5f): the agreed cluster ISS-603, 606, 608, 609,
// 612-615; "OK, open that cluster for me" then "I said open them for me" (LATEST in decide-tool.fixture.ts); ISS-603, 606 and 608
// already opened by the owner at 07:48 before the model's second turn; and the model's widening to
// ISS-616, 617, 569 and 607, which were never agreed. // i18n-allow: the owner's words quoted

import type { NeedsYouDecision } from '@forge/contracts/needs-you-decisions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RefusalError } from '../../lib/refusal.js';
import {
  CONVERSATION,
  EARLIER,
  kept,
  LATEST,
  needsYou,
  OWNER,
  opened,
  PROJECT,
  qid,
  repin,
  stewardOpen,
  WORD,
} from './decide-tool.fixture.js';

const answerAs = vi.fn();
const itemStateOf = vi.fn();
vi.mock('../../questions/index.js', () => ({ answerAs: (...a: unknown[]) => answerAs(...a) }));
vi.mock('../item-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../item-state.js')>()),
  itemStateOf: (...a: unknown[]) => itemStateOf(...a),
}));
vi.mock('../decision-acts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../decision-acts.js')>()),
  ...(await import('./decide-tool.fixture.js')).memoryDecisionActs,
}));

const { buildDecideToolset, provideNeedsYouDecisionRead, saidInMessage } = await import(
  './decide-tool.js'
);
provideNeedsYouDecisionRead(async () => needsYou.waiting);

const toolset = (latest: string, windowId: string) =>
  buildDecideToolset({
    projectId: PROJECT,
    userId: OWNER,
    conversationId: CONVERSATION,
    windowId,
    latestMessage: () => latest,
  });

const call = async (tool: string, latest: string, args: unknown, windowId = 'w-2') => {
  const r = await toolset(latest, windowId).execute(tool, JSON.stringify(args));
  const text = (r.content[0] as { text: string }).text;
  return { isError: r.isError === true, body: JSON.parse(text) as Record<string, unknown>, text };
};
const run = (latest: string, args: unknown, windowId?: string) =>
  call('act_on_decisions', latest, args, windowId);
/** Put a set to the person in the first turn, as the chat does before they agree. */
const put = async (decisions: unknown[], windowId = 'w-1') => {
  const out = await call('put_decision_set', 'which drafts are ready?', { decisions }, windowId);
  return { ...out, set: out.body.set as string };
};

beforeEach(() => {
  kept.sets.length = 0;
  kept.refused.length = 0;
  answerAs.mockReset().mockResolvedValue({});
  itemStateOf.mockReset().mockImplementation(async (_p: string, item: { key: string }) => {
    if (['ISS-603', 'ISS-606', 'ISS-608'].includes(item.key)) {
      return opened(item.key, 'Darrel', '2026-10-22T07:48:04.924Z');
    }
    if (/^ISS-6\d\d$/.test(item.key)) return opened(item.key, 'Darrel', '2026-10-22T07:52:00.000Z');
    return null;
  });
  needsYou.waiting = [609, 612, 613, 614, 615, 616, 617].map(stewardOpen).concat(repin);
});

describe("the person's word is in their latest message, or no decision is made (REQ-41 BC-25)", () => {
  it('makes the set they agreed as the person when their message says to, quoted as they wrote it', async () => {
    const { set } = await put([
      { decision: 'ISS-609' },
      { decision: 'issue:ISS-612:question.answer' },
    ]);
    // i18n-allow: the owner's word on dev
    const { isError, body } = await run(LATEST, { word: WORD, set });
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
        decision: 'issue:ISS-609:question.answer',
        id: 'issue:ISS-609:question.answer',
        answer: 'Open it: admit it for work',
        state: opened('ISS-609', 'Darrel', '2026-10-22T07:52:00.000Z'),
      },
      expect.objectContaining({ outcome: 'done', id: 'issue:ISS-612:question.answer' }),
    ]);
  });

  it('refuses a quote the latest message does not hold, though an earlier one did, and makes none', async () => {
    const { set } = await put([{ decision: 'ISS-609' }]);
    // i18n-allow: the owner's earlier message, not their latest
    const { isError, body } = await run(LATEST, { word: EARLIER, set });
    expect(isError).toBe(true);
    expect(String(body.error)).toMatch(/^CHAT_DECIDE_NO_WORD: /);
    expect(answerAs).not.toHaveBeenCalled();
  });

  it('refuses the model own words dressed as the quote, and a quote with no letter in it', async () => {
    const { set } = await put([{ decision: 'ISS-609' }]);
    for (const word of ['open them for me', '  ', '!!']) {
      const { isError, body } = await run(LATEST, { word, set });
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
  it('reports a set item opened by hand between the turns as already done, and makes the rest', async () => {
    needsYou.waiting = [603, 609].map(stewardOpen);
    const { set } = await put([{ decision: 'ISS-603' }, { decision: 'ISS-609' }]);
    // the owner opened ISS-603 themselves at 07:48, before their next message
    needsYou.waiting = [609].map(stewardOpen);
    const { body } = await run(LATEST, { word: WORD, set }); // i18n-allow: the owner's word on dev
    const results = body.results as { outcome: string; decision: string; state: unknown }[];
    expect(results[0]).toEqual({
      outcome: 'already_done',
      decision: 'issue:ISS-603:question.answer',
      state: opened('ISS-603', 'Darrel', '2026-10-22T07:48:04.924Z'),
    });
    expect(results[1]?.outcome).toBe('done');
    expect(answerAs).toHaveBeenCalledTimes(1);
  });

  it('reports ISS-603, 606 and 608 named in the message as already opened by the owner at 07:48', async () => {
    const latest = 'open ISS-603, ISS-606, ISS-608 and ISS-609 for me';
    const { body } = await run(latest, {
      word: 'open ISS-603, ISS-606, ISS-608 and ISS-609 for me',
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
    const { body } = await run('open ISS-9999 and the drafts', {
      word: 'open ISS-9999',
      decisions: [{ decision: 'ISS-9999' }, { decision: 'the drafts' }],
    });
    expect((body.results as { code: string }[]).map((r) => r.code)).toEqual([
      'DECISION_UNKNOWN',
      'DECISION_NOT_AGREED',
    ]);
    expect(answerAs).not.toHaveBeenCalled();
  });
});

describe('a decision is made only as its card would make it, and refused by name otherwise', () => {
  it('leaves a decision that is not a question answer to its card, naming its act', async () => {
    const latest = 'approve ISS-700 for me';
    const { body } = await run(latest, { word: latest, decisions: [{ decision: 'repin:wf-1' }] });
    expect(body.results).toEqual([
      expect.objectContaining({ outcome: 'refused', code: 'DECISION_NOT_AGREED' }),
    ]);
    const named = { ...repin, key: 'ISS-700' } as NeedsYouDecision;
    needsYou.waiting = [...needsYou.waiting.filter((d) => d.id !== repin.id), named];
    const again = await run(latest, { word: latest, decisions: [{ decision: 'repin:wf-1' }] });
    expect(again.body.results).toEqual([
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
    needsYou.waiting = [...needsYou.waiting, bare as NeedsYouDecision];
    const latest = 'open ISS-609 and ISS-620';
    const { body } = await run(latest, {
      word: latest,
      decisions: [{ decision: 'ISS-609', answer: 'steward.merge' }, { decision: 'ISS-620' }],
    });
    expect((body.results as { code: string }[]).map((r) => r.code)).toEqual([
      'DECISION_ANSWER_UNKNOWN',
      'DECISION_NO_RECOMMENDATION',
    ]);
  });

  it('refuses a key that names two decisions, naming both ids', async () => {
    needsYou.waiting = [
      ...needsYou.waiting,
      { ...stewardOpen(609), id: 'issue:ISS-609:steward.second' },
    ];
    const { body } = await run('open ISS-609', {
      word: 'open ISS-609',
      decisions: [{ decision: 'ISS-609' }],
    });
    const [only] = body.results as { code: string; detail: string }[];
    expect(only?.code).toBe('DECISION_AMBIGUOUS');
    expect(only?.detail).toContain('issue:ISS-609:steward.second');
  });

  it("carries the route's own refusal with the item read back, keeps it, and goes on to the next", async () => {
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
    const latest = 'open ISS-613 and ISS-614';
    const { body } = await run(latest, {
      word: latest,
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
    expect(kept.refused).toContainEqual(
      expect.objectContaining({
        conversationId: CONVERSATION,
        decisionId: 'issue:ISS-613:question.answer',
        key: 'ISS-613',
        via: 'chat',
        code: 'QUESTION_ROUND_STALE',
      }),
    );
  });

  it('runs as the person the turn answers, and never as anyone else', () => {
    const set = toolset('', 'w-1');
    expect(set.ranAs('act_on_decisions')).toBe(OWNER);
    expect(set.ranAs('put_decision_set')).toBe(OWNER);
  });
});
