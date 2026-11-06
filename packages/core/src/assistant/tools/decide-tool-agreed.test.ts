// ISS-624, judge K66 on dev.304 (REQ-41 BC-25, BC-28): what the person agreed is the set the act runs
// on, held by core rather than the prompt, so the model can neither widen nor narrow it; and a
// decision refused twice in the conversation is not made or offered a third time, and Forge's own
// feedback records it. Fixtures are the owner's conversation a760cd5f (`decide-tool.fixture.ts`).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RefusalError } from '../../lib/refusal.js';
import {
  CONVERSATION,
  kept,
  LATEST,
  needsYou,
  OWNER,
  opened,
  PROJECT,
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

const { buildDecideToolset, provideNeedsYouDecisionRead } = await import('./decide-tool.js');
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

describe('what the person agreed is the set the act runs on, held by core (ISS-624, judge K66 c1)', () => {
  it('cannot widen the set: an act naming both a set and decisions is refused, and makes none', async () => {
    const { set } = await put([{ decision: 'ISS-609' }, { decision: 'ISS-612' }]);
    const { isError, body } = await run(LATEST, {
      word: WORD, // i18n-allow: the owner's word on dev
      set,
      decisions: [{ decision: 'ISS-616' }],
    });
    expect(isError).toBe(true);
    expect(String(body.error)).toMatch(/^CHAT_DECIDE_INVALID: set: name exactly one of set/);
    expect(answerAs).not.toHaveBeenCalled();
  });

  it("cannot widen past the person's word: a decision their message does not name is refused", async () => {
    // the a760cd5f widening: ISS-616 and ISS-617 were never agreed
    const { body } = await run(LATEST, {
      word: WORD, // i18n-allow: the owner's word on dev
      decisions: [{ decision: 'ISS-616' }, { decision: 'ISS-617' }],
    });
    expect((body.results as { code: string }[]).map((r) => r.code)).toEqual([
      'DECISION_NOT_AGREED',
      'DECISION_NOT_AGREED',
    ]);
    expect(answerAs).not.toHaveBeenCalled();
  });

  it('cannot narrow the set: every decision put is made, each reported with its state', async () => {
    const { set } = await put([609, 612, 613].map((n) => ({ decision: `ISS-${n}` })));
    const { body } = await run('open them', { word: 'open them', set });
    const results = body.results as { outcome: string; state: { key: string } }[];
    expect(results.map((r) => [r.outcome, r.state.key])).toEqual([
      ['done', 'ISS-609'],
      ['done', 'ISS-612'],
      ['done', 'ISS-613'],
    ]);
    expect(answerAs).toHaveBeenCalledTimes(3);
  });

  it('refuses a set put in the same turn: the person has not seen it to agree it', async () => {
    const { set } = await put([{ decision: 'ISS-609' }], 'w-2');
    const { isError, body } = await run('open them', { word: 'open them', set }, 'w-2');
    expect(isError).toBe(true);
    expect(String(body.error)).toMatch(/^CHAT_DECIDE_SET_UNSEEN: /);
    expect(answerAs).not.toHaveBeenCalled();
  });

  it('refuses a set that is not the newest put, naming the newest and its items', async () => {
    const first = await put([{ decision: 'ISS-609' }]);
    await put([{ decision: 'ISS-612' }]);
    const { isError, body } = await run('open them', { word: 'open them', set: first.set });
    expect(isError).toBe(true);
    expect(String(body.error)).toMatch(/^CHAT_DECIDE_SET_UNKNOWN: .*\(ISS-612\)/);
  });

  it('puts only a decision the chat can make, refusing the set whole by name otherwise', async () => {
    const out = await put([
      { decision: 'ISS-609' },
      { decision: 'repin:wf-1' },
      { decision: 'ISS-9999' },
    ]);
    expect(out.isError).toBe(true);
    expect(String(out.body.error)).toMatch(/^CHAT_DECISION_SET_REFUSED: /);
    expect(String(out.body.error)).toContain('DECISION_ACT_ON_ITS_PAGE');
    expect(String(out.body.error)).toContain('DECISION_UNKNOWN: ISS-9999');
    expect(kept.sets).toEqual([]);
  });

  it('returns the set with each item by its key and answer, for the model to list', async () => {
    const out = await put([{ decision: 'ISS-609' }]);
    expect(out.body.items).toEqual([
      {
        decision: 'issue:ISS-609:question.answer',
        key: 'ISS-609',
        answer: 'Open it: admit it for work',
      },
    ]);
    expect(String(out.body.note)).toContain(`with set ${out.set}`);
  });
});

describe('a decision refused twice is not offered a third time, and Forge records it (ISS-624, judge K66 c4)', () => {
  const stale = () =>
    new RefusalError(
      [{ code: 'QUESTION_ROUND_STALE', path: '', detail: 'round 1 was answered' }],
      'QUESTION_REFUSED',
    );

  it('keeps each refused act; the second names the feedback item, and the third is not made', async () => {
    answerAs.mockRejectedValueOnce(stale()).mockRejectedValueOnce(stale());
    const latest = 'open ISS-613';
    const once = await run(latest, { word: latest, decisions: [{ decision: 'ISS-613' }] });
    const twice = await run(latest, { word: latest, decisions: [{ decision: 'ISS-613' }] });
    const third = await run(latest, { word: latest, decisions: [{ decision: 'ISS-613' }] });
    const [r1, r2, r3] = [once, twice, third].map(
      (o) => (o.body.results as { code: string; detail: string }[])[0],
    );
    expect([r1?.code, r2?.code, r3?.code]).toEqual([
      'DECISION_REFUSED',
      'DECISION_REFUSED',
      'DECISION_REFUSED_TWICE',
    ]);
    expect(r1?.detail).not.toContain('FB-77');
    expect(r2?.detail).toContain('FB-77');
    expect(r3?.detail).toContain('FB-77');
    expect(answerAs).toHaveBeenCalledTimes(2);
  });

  it('will not put a decision refused twice into a set', async () => {
    kept.refused.push(
      {
        decisionId: 'issue:ISS-613:question.answer',
        key: 'ISS-613',
        via: 'card',
        code: 'X_REFUSED',
        detail: 'no',
      },
      {
        decisionId: 'issue:ISS-613:question.answer',
        key: 'ISS-613',
        via: 'chat',
        code: 'X_REFUSED',
        detail: 'no',
      },
    );
    const out = await put([{ decision: 'ISS-613' }]);
    expect(out.isError).toBe(true);
    expect(String(out.body.error)).toContain('DECISION_REFUSED_TWICE');
    expect(String(out.body.error)).toContain('FB-77');
  });
});
