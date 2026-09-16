/**
 * ISS-1059 - the score, the ranking, the marks, the judge column that never enters the score, and
 * the two printers. A planted cliff (one task at 0% on the run with the best mean) is shown beside
 * its score, which is the whole reason a score may be printed at all.
 */

import { describe, expect, it } from 'vitest';
import { sideOf } from './compare.js';
import type { HistoryResult } from './history/result.js';
import type { Group } from './history/summarize.js';
import {
  deltaLine,
  ladderLines,
  ladderMarkdown,
  mdCell,
  rankRuns,
  rankWindows,
  score,
  scoreDefinition,
} from './ladder.js';
import type { BenchResult, TrialResult } from './result.js';

const trial = (pass: boolean, seconds = 10, served?: 'yes' | 'partial' | 'no'): TrialResult => ({
  at: '2026-09-16T00:00:00.000Z',
  pass,
  error: null,
  seconds,
  turns: [
    {
      index: 0,
      message: 'm',
      reply: 'r',
      pass,
      modes: pass ? [] : ['unanswered'],
      evidence: [],
      seconds,
      attempts: [],
      ...(served ? { judge: { intent: 'i', served, reason: 'r', quote: '' } } : {}),
    },
  ],
  cleanup: {
    rooms: [{ id: 'room', expected: 'deleted', observed: '404', at: '2026-09-16T00:00:01.000Z' }],
    preferences: { expected: null, observed: null, equal: null, at: null },
    auditRowsAdded: 0,
    memories: null,
  },
});
const P = (n: number, seconds?: number) => Array.from({ length: n }, () => trial(true, seconds));
const F = (n: number, seconds?: number) => Array.from({ length: n }, () => trial(false, seconds));

const file = (over: Partial<BenchResult>, trials: Record<string, TrialResult[]>): BenchResult => ({
  at: '2026-09-16T00:00:00.000Z',
  api: 'https://beta',
  commit: 'aaaaaaaa1',
  version: '0.3.0',
  model: 'terra',
  runId: 'r',
  k: 3,
  tasks: Object.entries(trials).map(([id, t]) => ({
    id,
    capability: 'method' as const,
    trials: t,
  })),
  ...over,
});
const SHIPPED = ['a', 'b', 'c'];
const sidesOf = (r: BenchResult) =>
  rankRuns([{ name: 'x', result: r }], SHIPPED)[0] ?? (undefined as never);

describe('score', () => {
  it('is the mean of pass^k over the sides with an estimator, 0-100 to one decimal, with the lowest task', () => {
    const r = file({}, { a: P(3), b: [...P(2), ...F(1)], c: [...P(1), ...F(2)] });
    const row = sidesOf(r);
    // pass^3 over 3 trials: 100%, 0%, 0% → mean 33.3
    expect(row.score).toBe(33.3);
    expect(row.lowest).toEqual({ id: 'b', passK: 0 });
  });

  it('is null where no side has an estimator, and ties on the lowest task break by id', () => {
    expect(score([{ id: 'a', side: sideOf(P(1), 3) }])).toEqual({ score: null, lowest: null });
    const row = sidesOf(file({}, { z: F(3), y: F(3), a: P(3) }));
    expect(row.lowest?.id).toBe('y');
  });
});

describe('rankRuns', () => {
  const best = file({ commit: 'bbbbbbbb2', model: 'astra' }, { a: P(3), b: P(3), c: F(3) });
  const steady = file({}, { a: [...P(2), ...F(1)], b: P(3), c: P(3) });
  const same = file({ commit: 'cccccccc3' }, { a: P(3), b: F(3), c: P(3) });

  it('ranks by score, then by the lowest task, then by name', () => {
    const rows = rankRuns(
      [
        { name: 'steady.json', result: steady },
        { name: 'best.json', result: best },
        { name: 'same.json', result: same },
      ],
      SHIPPED,
    );
    expect(rows.map((r) => [r.name, r.score, r.lowest?.id])).toEqual([
      ['best.json', 66.7, 'c'],
      ['same.json', 66.7, 'b'],
      ['steady.json', 66.7, 'a'],
    ]);
  });

  it('a planted cliff stands beside the best score', () => {
    const cliff = file({}, { a: P(3), b: P(3), c: F(3) });
    const row = sidesOf(cliff);
    expect(row.score).toBe(66.7);
    expect(row.lowest).toEqual({ id: 'c', passK: 0 });
    expect(row.fullTasks).toBe(2);
  });

  it('marks partial with both counts, marks thin, and reads the judge as a column', () => {
    const partial = sidesOf(file({}, { a: P(3), b: P(3) }));
    expect(partial).toMatchObject({ partial: true, tasksWalked: 2, tasksShipped: 3, thin: false });
    const thin = sidesOf(file({}, { a: P(3), b: P(3), c: P(2) }));
    expect(thin.thin).toBe(true);
    const judged = sidesOf(
      file(
        { judge: { model: 'j' } },
        {
          a: [trial(true, 10, 'yes'), trial(true, 10, 'no'), trial(true, 10, 'yes')],
          b: P(3),
          c: P(3),
        },
      ),
    );
    expect(judged.judgeServed).toEqual({ yes: 2, judged: 3 });
    expect(judged.score).toBe(100);
    expect(sidesOf(file({}, { a: P(3), b: P(3), c: P(3) })).judgeServed).toBeNull();
  });

  it('takes one k, the largest any file names, for every side, so files at different k rank on the same figure', () => {
    // 2 of 3 passing at k = 1 would score 66.7 on its own k; 3 of 4 passing at k = 3 scores 25.0.
    // At the common k = 3 they are 0 and 25, and the 3-of-4 run ranks first.
    const atOne = file({ k: 1 }, { a: [...P(2), ...F(1)] });
    const atThree = file({ k: 3 }, { a: [...P(3), ...F(1)] });
    const rows = rankRuns(
      [
        { name: 'one.json', result: atOne },
        { name: 'three.json', result: atThree },
      ],
      ['a'],
    );
    expect(rows.map((r) => [r.name, r.k, r.score])).toEqual([
      ['three.json', 3, 25],
      ['one.json', 3, 0],
    ]);
    expect(ladderLines(rows, [])).toContain(scoreDefinition(3));
  });

  it('medians the trial seconds across every task', () => {
    expect(sidesOf(file({}, { a: P(3, 4), b: P(3, 8), c: P(3, 20) })).medianSeconds).toBe(8);
  });
});

const group = (over: Partial<Group>): Group => ({
  model: 'terra',
  source: 'web',
  rows: 40,
  sessions: 20,
  thin: false,
  modes: {} as Group['modes'],
  medians: { ms: 1, calls: 1, iterations: 1 },
  ...over,
});
const history = (
  over: Partial<HistoryResult>,
  judged: Array<'yes' | 'partial' | 'no' | 'error'> = [],
): HistoryResult => ({
  at: 'now',
  api: 'https://beta',
  commit: 'dddddddd4',
  version: '0.3.0',
  window: { projectSlug: 'qa', from: '2026-09-01', to: '2026-09-08', source: null },
  budgetSeconds: 60,
  maxIterations: 8,
  resolved: false,
  excludedSessions: [],
  excludedRows: 0,
  groups: [group({})],
  flagged: [],
  ...(judged.length > 0
    ? {
        judge: {
          model: 'j',
          sample: 40,
          rows: judged.map((served, i) => ({
            chatLogId: `l${i}`,
            sessionId: 's',
            createdAt: 'now',
            model: 'terra',
            source: 'web',
            modes: [],
            judge:
              served === 'error' ? { error: 'x' } : { intent: 'i', served, reason: 'r', quote: '' },
          })),
          groups: [],
          agreement: { ruleFailed: { judged: 0, no: 0 }, clean: { judged: 0, yes: 0 } },
        },
      }
    : {}),
  ...over,
});

describe('rankWindows', () => {
  it('ranks by served rate, then by the fewest flagged rows, then by name, and carries thin', () => {
    const rows = rankWindows([
      { name: 'c.json', result: history({ groups: [group({ rows: 10, sessions: 5 })] }) },
      { name: 'b.json', result: history({}, ['yes', 'yes', 'no', 'error']) },
      { name: 'a.json', result: history({}, ['yes', 'yes', 'yes', 'partial']) },
      { name: 'd.json', result: history({ flagged: [{} as never] }) },
    ]);
    expect(rows.map((r) => [r.name, r.servedRate, r.flaggedRate.flagged, r.thin])).toEqual([
      ['a.json', { yes: 3, judged: 4 }, 0, false],
      ['b.json', { yes: 2, judged: 4 }, 0, false],
      ['c.json', null, 0, true],
      ['d.json', null, 1, false],
    ]);
    expect(rows[0]?.window).toBe('qa 2026-09-01..2026-09-08');
  });
});

describe('the printers', () => {
  const runs = rankRuns(
    [
      {
        name: 'best.json',
        result: file(
          { judge: { model: 'j' } },
          {
            a: [trial(true, 10, 'yes'), trial(true, 10, 'yes'), trial(true, 10, 'no')],
            b: P(3),
            c: F(3),
          },
        ),
      },
      {
        name: 'plain.json',
        result: file({ commit: null, model: null }, { a: P(3), b: F(3), c: F(3) }),
      },
    ],
    SHIPPED,
  );
  const windows = rankWindows([{ name: 'h.json', result: history({}, ['yes', 'no']) }]);

  it('prints the definition under the run table, every score beside its lowest task, the judge column, and a delta line', () => {
    const lines = ladderLines(runs, windows);
    expect(lines[0]).toBe('runs');
    const best = lines.find((l) => l.includes('best.json')) ?? '';
    expect(best).toMatch(/66\.7\s+c 0%\s+2\/3\s+67% \(2\/3\)\s+10\.0s/);
    const plain = lines.find((l) => l.includes('plain.json')) ?? '';
    expect(plain).toMatch(/33\.3\s+b 0%\s+1\/3\s+—\s+10\.0s/);
    expect(lines.indexOf(scoreDefinition(3))).toBeGreaterThan(lines.indexOf(plain));
    expect(scoreDefinition(3)).toContain('at k = 3');
    expect(lines.find((l) => l.startsWith('delta'))).toBe(
      'delta (1st over 2nd): score +33.4; lowest task 0% vs 0%; full tasks +1; judge served 67% (2/3) vs —; median +0.0s',
    );
    expect(lines).toContain('history windows');
    expect(lines.find((l) => l.includes('h.json'))).toMatch(/40\s+20\s+50% \(1\/2\)\s+0\/40/);
    expect(lines.some((l) => /weighted|overall|total/i.test(l))).toBe(false);
  });

  it('prints a Capabilities table, one column per capability walked, each score beside its lowest task (ISS-1061)', () => {
    const mixed = file({}, { a: P(3), b: F(3), c: P(3) });
    mixed.tasks = mixed.tasks.map((t) => ({
      ...t,
      capability: t.id === 'a' ? ('long-context' as const) : ('method' as const),
    }));
    const rows = rankRuns([{ name: 'x.json', result: mixed }], SHIPPED);
    expect(rows[0]?.capabilities.map((c) => [c.capability, c.score, c.tasks])).toEqual([
      ['method', 50, ['b', 'c']],
      ['long-context', 100, ['a']],
    ]);
    const lines = ladderLines(rows, []);
    const at = lines.indexOf('capabilities');
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toMatch(/^#\s+run\s+method\s+long-context$/);
    expect(lines[at + 2]).toMatch(
      /^1\s+x\.json\s+50\.0 b 0% \(1\/2 full\)\s+100\.0 a 100% \(1\/1 full\)$/,
    );
    const md = ladderMarkdown(rows, []);
    expect(md).toContain('### Capabilities');
    expect(md).toContain('| 1 | x.json | 50.0 b 0% (1/2 full) | 100.0 a 100% (1/1 full) |');
  });

  it('never prints a score without the lowest task on the same row', () => {
    for (const line of ladderLines(runs, [])) {
      if (/^\d+\s/.test(line)) expect(line).toMatch(/\d+\.\d\s+\S+ \d+%/);
    }
  });

  it('escapes a backslash before a pipe in a Markdown cell, so neither splits the row', () => {
    expect(mdCell('a|b')).toBe('a\\|b');
    expect(mdCell('a\\|b')).toBe('a\\\\\\|b');
    expect(mdCell('plain')).toBe('plain');
  });

  it('renders the same rows as Markdown tables with the definition in italics', () => {
    const md = ladderMarkdown(runs, windows);
    expect(md).toContain('### Runs');
    expect(md).toContain(
      '| 1 | best.json | aaaaaaaa | terra | 66.7 | c 0% | 2/3 | 67% (2/3) | 10.0s | — |',
    );
    expect(md).toContain(`_${scoreDefinition(3)}_`);
    expect(md).toContain('### History windows');
    expect(md).toContain(
      '| 1 | h.json | dddddddd | qa 2026-09-01..2026-09-08 | 40 | 20 | 50% (1/2) | 0/40 | — |',
    );
    expect(deltaLine(runs.slice(0, 1))).toBeNull();
  });
});
