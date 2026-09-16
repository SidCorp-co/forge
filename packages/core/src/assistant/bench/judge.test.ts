/**
 * ISS-1054 - the judge: the messages it is sent, the answers it may and may not give, the tallies
 * and the agreement with the rules, the adapter over a scripted endpoint, and the environment
 * reader. Nothing here touches a mode or a pass.
 */

import { describe, expect, it } from 'vitest';
import { createFakeDeployment, JUDGE_KEY, JUDGE_URL } from './fake-deployment.js';
import {
  agreement,
  agreementLine,
  callLines,
  createJudge,
  isVerdict,
  type JudgeResult,
  judgeFromEnv,
  judgeMessages,
  NO_REPLY,
  parseVerdict,
  tally,
  tallyLine,
} from './judge.js';

const input = {
  query: 'How many open issues are there?',
  reply: 'There are 3 open issues in QA Project.',
  calls: ['forge issue --status open', 'forge issue ISS-7 (error)'],
  error: null,
};
const yes = JSON.stringify({
  intent: 'count the open issues',
  served: 'yes',
  reason: 'It gives the count.',
  quote: '3 open issues',
});

describe('judgeMessages', () => {
  it('carries the query, the reply, every call with its error mark, the error and the four keys', () => {
    const [system, user] = judgeMessages(input);
    expect(system?.role).toBe('system');
    for (const key of ['"intent"', '"served"', '"reason"', '"quote"'])
      expect(String(system?.content)).toContain(key);
    const text = String(user?.content);
    expect(text).toContain(input.query);
    expect(text).toContain(input.reply);
    expect(text).toContain('- forge issue --status open');
    expect(text).toContain('- forge issue ISS-7 (error)');
    expect(text).toContain('Error recorded on the turn: none');
  });

  it('says no reply was delivered for a null reply, and names the error', () => {
    const [, user] = judgeMessages({ ...input, reply: null, calls: [], error: 'provider timeout' });
    const text = String(user?.content);
    expect(text).toContain(NO_REPLY);
    expect(text).toContain('- none');
    expect(text).toContain('Error recorded on the turn: provider timeout');
  });

  it('callLines renders forge argv, other tools by name, and marks errors', () => {
    expect(
      callLines([
        { name: 'forge', arguments: '', argv: ['issue', '-h'], isError: false, durationMs: 1 },
        { name: 'search', arguments: '', argv: null, isError: true, durationMs: 1 },
      ]),
    ).toEqual(['forge issue -h', 'search (error)']);
  });
});

describe('parseVerdict', () => {
  it('reads a JSON object, bare or fenced', () => {
    const v = { intent: 'count', served: 'yes', reason: 'r', quote: '3 open issues' };
    expect(parseVerdict(JSON.stringify(v), input.reply)).toEqual(v);
    expect(parseVerdict(`Here:\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``, input.reply)).toEqual(v);
  });

  it('refuses by name: not JSON, not an object, a missing key, a served outside the set', () => {
    expect(() => parseVerdict('I think it was fine.', input.reply)).toThrow(
      'judge answer is not JSON',
    );
    expect(() => parseVerdict('[1]', input.reply)).toThrow('judge answer is not an object');
    expect(() => parseVerdict('{"intent":"x","served":"yes","reason":"r"}', input.reply)).toThrow(
      'judge answer lacks quote',
    );
    expect(() =>
      parseVerdict('{"intent":"x","served":"mostly","reason":"r","quote":""}', input.reply),
    ).toThrow('judge served is mostly, not yes, partial or no');
  });

  it('refuses a quote the reply never said, folds whitespace, and allows only an empty quote for no reply', () => {
    const bad = { intent: 'x', served: 'yes', reason: 'r', quote: 'four open issues' };
    expect(() => parseVerdict(JSON.stringify(bad), input.reply)).toThrow(
      'judge quote is not in the reply: four open issues',
    );
    const folded = { ...bad, quote: '3   open\nissues' };
    expect(parseVerdict(JSON.stringify(folded), input.reply).quote).toBe('3   open\nissues');
    expect(() => parseVerdict(JSON.stringify(bad), null)).toThrow(
      'judge quoted a reply that was never delivered',
    );
    expect(parseVerdict(JSON.stringify({ ...bad, served: 'no', quote: '' }), null).served).toBe(
      'no',
    );
  });
});

describe('tally and agreement', () => {
  const v = (served: 'yes' | 'partial' | 'no'): JudgeResult => ({
    intent: 'i',
    served,
    reason: 'r',
    quote: '',
  });

  it('counts every kind of result', () => {
    const t = tally([v('yes'), v('yes'), v('partial'), v('no'), { error: 'unreadable' }]);
    expect(t).toEqual({ judged: 5, yes: 2, partial: 1, no: 1, unreadable: 1 });
    expect(tallyLine(t)).toBe('judge yes 2/5, partial 1/5, no 1/5, unreadable 1/5');
  });

  it('reads agreement off rule-failed and clean rows only, skipping unreadable answers', () => {
    const a = agreement([
      { modes: ['fallback_sent'], judge: v('no') },
      { modes: ['unanswered'], judge: v('yes') },
      { modes: [], judge: v('yes') },
      { modes: [], judge: v('partial') },
      { modes: ['help_roundtrip'], judge: v('yes') },
      { modes: [], judge: { error: 'x' } },
      { modes: [], judge: undefined },
    ]);
    expect(a).toEqual({ ruleFailed: { judged: 2, no: 1 }, clean: { judged: 2, yes: 1 } });
    expect(agreementLine(a)).toBe(
      'agreement: rule-failed rows judged no 1/2, clean rows judged yes 1/2',
    );
  });
});

describe('createJudge over the scripted endpoint', () => {
  const judgeOf = (answer: (i: { query: string; reply: string | null }) => string | number) => {
    const fake = createFakeDeployment({ script: () => ({ attempts: [] }), judge: answer });
    return {
      fake,
      judge: createJudge({
        baseUrl: JUDGE_URL,
        apiKey: JUDGE_KEY,
        model: 'judge-model',
        fetch: fake.fetch,
        retryDelaysMs: [0],
      }),
    };
  };

  it('posts one request naming the model and returns the parsed verdict', async () => {
    const { fake, judge } = judgeOf((i) => (i.reply?.includes('3 open') ? yes : '{}'));
    const result = await judge.judge(input);
    expect(isVerdict(result) && result.served).toBe('yes');
    const posts = fake.state.requests.filter((r) => r.path === '/v1/chat/completions');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.model).toBe('judge-model');
  });

  it('returns an error, never throws, for an unreadable answer and for a refused status', async () => {
    const { judge } = judgeOf(() => 'It was fine.');
    expect(await judge.judge(input)).toEqual({
      error: 'judge answer is not JSON: It was fine.',
    });
    const refused = judgeOf(() => 500);
    const result = await refused.judge.judge(input);
    expect('error' in result && result.error).toMatch(/^judge stream: /);
  });
});

describe('judgeFromEnv', () => {
  it('refuses by name without the two variables and builds the judge with them', () => {
    const fetch = createFakeDeployment({ script: () => ({ attempts: [] }) }).fetch;
    expect(() => judgeFromEnv({}, 'm', fetch)).toThrow(
      'no judge credential: set FORGE_BENCH_JUDGE_URL and FORGE_BENCH_JUDGE_KEY',
    );
    expect(() => judgeFromEnv({ FORGE_BENCH_JUDGE_URL: JUDGE_URL }, 'm', fetch)).toThrow(
      'FORGE_BENCH_JUDGE_KEY',
    );
    expect(
      judgeFromEnv(
        { FORGE_BENCH_JUDGE_URL: JUDGE_URL, FORGE_BENCH_JUDGE_KEY: JUDGE_KEY },
        'm',
        fetch,
      ).model,
    ).toBe('m');
  });
});
