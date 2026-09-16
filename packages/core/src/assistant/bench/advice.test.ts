/**
 * ISS-1058 - one planted input per advice line, the screen's three subsets (unjudged rows ask for
 * a judge, served rows send the reader to the rejected attempt, judged-no rows keep the screen),
 * a partly judged group keeping the judge-first line for its remainder (codex F2), the
 * thresholds, a clean input, and the counts passing through unchanged.
 */

import { describe, expect, it } from 'vitest';
import {
  type AdviceInput,
  adviceInputsOfHistory,
  adviceInputsOfRun,
  adviceLines,
  advise,
  type FlaggedInput,
  THRESHOLDS,
} from './advice.js';
import type { FailureMode } from './grade.js';
import type { HistoryResult } from './history/result.js';
import type { BenchResult } from './result.js';

const input = (over: Partial<AdviceInput>): AdviceInput => ({
  label: 't',
  rows: 10,
  flagged: [],
  ...over,
});
const row = (
  modes: FailureMode[],
  served: 'yes' | 'partial' | 'no' | null = null,
): FlaggedInput => ({ modes, served });
const SCREEN = 'screen_repair/fallback_sent';
const JUDGE_FIRST = 'bench:assistant run --judge / history --judge';

describe('the screen', () => {
  it('rows the judge called served say the repair served and send the reader to the rejected attempt, never that the screen should accept it', () => {
    const lines = advise([
      input({
        flagged: [
          row(['screen_repair', 'fallback_sent'], 'yes'),
          row(['fallback_sent'], 'partial'),
        ],
      }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      pattern: SCREEN,
      count: 2,
      rows: 10,
      threshold: 'above 0, repaired reply judged yes/partial',
      surface: 'conversations/screened-reply.ts:screenReply',
    });
    expect(lines[0]?.change).toContain(
      'the verdict is on the repaired reply, not the rejected one',
    );
    expect(lines[0]?.change).toContain(
      'loosen the shape check only where it answered the question',
    );
    expect(lines[0]?.change).not.toMatch(/should accept/);
  });

  it('rows the judge called no keep the screen: the fault is upstream of it', () => {
    const lines = advise([input({ flagged: [row(['screen_repair'], 'no')] })]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      count: 1,
      threshold: 'above 0, repaired reply judged no',
      change: 'the repair did not serve either; the fault is upstream of the screen, keep it',
    });
  });

  it('unjudged rows ask for a judge and never advise loosening', () => {
    const lines = advise([
      input({ flagged: [row(['screen_repair']), row(['screen_repair']), row(['screen_repair'])] }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      count: 3,
      threshold: 'above 0, unjudged',
      surface: JUDGE_FIRST,
    });
    expect(lines[0]?.change).toContain('judge these rows before touching the screen');
    expect(lines[0]?.change).not.toContain('loosen');
  });

  it('a partly judged group keeps the judge-first line for its unjudged remainder, each line counting its own rows', () => {
    for (const served of ['yes', 'no'] as const) {
      const flagged = [
        row(['screen_repair'], served),
        ...Array.from({ length: 9 }, () => row(['screen_repair'])),
      ];
      const lines = advise([input({ rows: 12, flagged })]);
      expect(lines.map((l) => [l.count, l.threshold, l.surface])).toEqual([
        [9, 'above 0, unjudged', JUDGE_FIRST],
        [
          1,
          served === 'yes'
            ? 'above 0, repaired reply judged yes/partial'
            : 'above 0, repaired reply judged no',
          'conversations/screened-reply.ts:screenReply',
        ],
      ]);
    }
  });

  it('a verdict on a row without a screen mode does not judge the screen rows', () => {
    const lines = advise([
      input({ flagged: [row(['screen_repair']), row(['help_roundtrip'], 'yes')] }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ pattern: SCREEN, count: 1, threshold: 'above 0, unjudged' });
  });

  it('gives all three lines when the judge split and some rows were not asked', () => {
    const lines = advise([
      input({
        flagged: [
          row(['screen_repair'], 'yes'),
          row(['screen_repair'], 'no'),
          row(['fallback_sent']),
        ],
      }),
    ]);
    expect(lines.map((l) => [l.count, l.threshold])).toEqual([
      [1, 'above 0, unjudged'],
      [1, 'above 0, repaired reply judged yes/partial'],
      [1, 'above 0, repaired reply judged no'],
    ]);
  });
});

describe('the other patterns', () => {
  it('help_roundtrip names the tool layer above 10% and is silent at or under it', () => {
    expect(THRESHOLDS.helpRoundtripShare).toBe(0.1);
    expect(advise([input({ rows: 10, flagged: [row(['help_roundtrip'])] })])).toEqual([]);
    const lines = advise([
      input({ rows: 10, flagged: [row(['help_roundtrip']), row(['help_roundtrip'])] }),
    ]);
    expect(lines[0]).toMatchObject({
      pattern: 'help_roundtrip',
      count: 2,
      threshold: 'above 10%',
      surface: 'guides/assistant-method-guide.ts:ASSISTANT_METHOD_GUIDE',
    });
  });

  it('links, the loop, the language and the door each name their surface', () => {
    const lines = advise([
      input({
        flagged: [
          row(['wrong_link_shape', 'dead_link']),
          row(['dead_link']),
          row(['over_budget', 'repeated_call']),
          row(['repeated_call']),
          row(['repeated_call']),
          row(['language_mismatch']),
          row(['unanswered']),
        ],
      }),
    ]);
    expect(lines.map((l) => [l.pattern, l.count, l.surface])).toEqual([
      [
        'wrong_link_shape/dead_link',
        2,
        'messaging/text-rules.ts:ISSUE_NAV_RE and the link line in assistant/door-persona.ts:assistantOpening',
      ],
      ['over_budget/repeated_call', 3, 'assistant/run-turn-core.ts:runTurnEvents'],
      ['language_mismatch', 1, 'assistant/door-persona.ts'],
      ['unanswered', 1, 'conversations/turn-runner.ts'],
    ]);
  });

  it('every line carries the pattern, its count over the rows, its threshold and a surface, with the counts as given', () => {
    const lines = advise([
      input({
        label: 'g',
        rows: 48,
        flagged: Array.from({ length: 12 }, () => row(['help_roundtrip'])),
      }),
    ]);
    expect(lines[0]).toEqual({
      label: 'g',
      pattern: 'help_roundtrip',
      count: 12,
      rows: 48,
      threshold: 'above 10%',
      surface: 'guides/assistant-method-guide.ts:ASSISTANT_METHOD_GUIDE',
      change:
        "the method guide sends the model to -h for every verb; carry the verbs' usage so no -h call is needed",
    });
    expect(adviceLines(lines)[1]).toBe(
      "  g: help_roundtrip 12/48 (25%) above 10% -> guides/assistant-method-guide.ts:ASSISTANT_METHOD_GUIDE: the method guide sends the model to -h for every verb; carry the verbs' usage so no -h call is needed",
    );
  });

  it('a clean input, or one with no rows, prints the one none line', () => {
    expect(
      adviceLines(advise([input({}), input({ rows: 0, flagged: [row(['unanswered'])] })])),
    ).toEqual(['advice: none - every pattern is under its threshold']);
  });
});

describe('the inputs read off the files', () => {
  it('a row carrying two modes of one pattern is counted once', () => {
    const lines = advise([
      input({
        rows: 3,
        flagged: [row(['screen_repair', 'fallback_sent']), row(['screen_repair', 'fallback_sent'])],
      }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ count: 2, rows: 3, threshold: 'above 0, unjudged' });
  });

  it('a run file gives one input per task with turns as rows and each flagged turn carrying its verdict', () => {
    const turn = (modes: FailureMode[], served?: 'yes' | 'no') => ({
      index: 0,
      message: 'm',
      reply: 'r',
      pass: modes.length === 0,
      modes,
      evidence: [],
      seconds: 1,
      attempts: [],
      ...(served ? { judge: { intent: 'i', served, reason: 'r', quote: '' } } : {}),
    });
    const trial = (turns: ReturnType<typeof turn>[]) => ({
      at: 'x',
      retried: 0,
      pass: turns.every((t) => t.pass),
      error: null,
      seconds: 1,
      turns,
      cleanup: {
        rooms: [{ id: 'r', expected: 'deleted' as const, observed: '404', at: 'x' }],
        preferences: { expected: null, observed: null, equal: null, at: null },
        auditRowsAdded: 0,
        memories: null,
      },
    });
    const run: BenchResult = {
      at: 'x',
      api: 'a',
      commit: 'c',
      version: 'v',
      model: 'm',
      runId: 'r',
      k: 3,
      tasks: [
        {
          id: 'a',
          capability: 'method',
          trials: [
            trial([turn(['screen_repair'], 'yes'), turn([])]),
            trial([turn(['help_roundtrip'])]),
          ],
        },
      ],
    };
    expect(adviceInputsOfRun(run)).toEqual([
      {
        label: 'a',
        rows: 3,
        flagged: [
          { modes: ['screen_repair'], served: 'yes' },
          { modes: ['help_roundtrip'], served: null },
        ],
      },
    ]);
  });

  it('a history file gives one input per group with its flagged rows, each carrying its own verdict by chat_logs id', () => {
    const h = {
      flagged: [
        { chatLogId: 'l', model: 'm', source: 's', modes: ['help_roundtrip'] },
        { chatLogId: 'l2', model: 'other', source: 's', modes: ['unanswered'] },
        { chatLogId: 'l3', model: 'm', source: 's', modes: ['help_roundtrip', 'wrong_link_shape'] },
      ],
      groups: [
        {
          model: 'm',
          source: 's',
          rows: 40,
          sessions: 20,
          thin: false,
          modes: { help_roundtrip: { count: 12, rate: 0.3 }, unanswered: { count: 0, rate: 0 } },
          medians: { ms: 1, calls: 1, iterations: 1 },
        },
      ],
      judge: {
        model: 'j',
        sample: 40,
        rows: [
          {
            chatLogId: 'l',
            sessionId: 's',
            createdAt: 'x',
            model: 'm',
            source: 's',
            modes: ['help_roundtrip'],
            judge: { intent: 'i', served: 'yes', reason: 'r', quote: '' },
          },
          {
            chatLogId: 'l2',
            sessionId: 's',
            createdAt: 'x',
            model: 'other',
            source: 's',
            modes: [],
            judge: { error: 'x' },
          },
        ],
        groups: [],
        agreement: { ruleFailed: { judged: 0, no: 0 }, clean: { judged: 0, yes: 0 } },
      },
    } as unknown as HistoryResult;
    expect(adviceInputsOfHistory(h)).toEqual([
      {
        label: 'm / s',
        rows: 40,
        flagged: [
          { modes: ['help_roundtrip'], served: 'yes' },
          { modes: ['help_roundtrip', 'wrong_link_shape'], served: null },
        ],
      },
    ]);
  });
});
