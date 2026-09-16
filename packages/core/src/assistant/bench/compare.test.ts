/**
 * ISS-1051 — pass^k and pass@k are estimators over the trials observed, not the pass rate under
 * another name: pass/pass/fail at k = 3 is pass^3 = 0 and pass@3 = 1. A thin side gets no estimator,
 * and nothing in the comparison is a composite.
 */

import { describe, expect, it } from 'vitest';
import { choose, compare, compareLines, median, sideOf } from './compare.js';
import type { BenchResult, TrialResult } from './result.js';

const trial = (pass: boolean, over: Partial<TrialResult> = {}): TrialResult => ({
  at: '2026-09-16T00:00:00.000Z',
  pass,
  error: null,
  seconds: 10,
  turns: [
    {
      index: 0,
      message: 'm',
      reply: 'r',
      pass,
      modes: pass ? [] : ['unanswered'],
      evidence: pass ? [] : [{ mode: 'unanswered', fact: 'planted' }],
      seconds: 10,
      attempts: [{ chatLogId: 'l', calls: 2, iterations: 1, ms: 100, reply: 'r', error: null }],
    },
  ],
  cleanup: {
    room: { id: 'room', expected: 'deleted', observed: '404', at: '2026-09-16T00:00:01.000Z' },
    preferences: { expected: null, observed: null, equal: null, at: null },
    auditRowsAdded: 0,
  },
  ...over,
});

const file = (over: Partial<BenchResult>, trials: Record<string, TrialResult[]>): BenchResult => ({
  at: '2026-09-16T00:00:00.000Z',
  api: 'https://beta',
  commit: 'aaa',
  version: '0.3.0',
  model: 'm1',
  runId: 'r1',
  k: 3,
  tasks: Object.entries(trials).map(([id, t]) => ({ id, trials: t })),
  ...over,
});

describe('the estimators', () => {
  it('choose', () => {
    expect([choose(3, 3), choose(3, 2), choose(2, 3), choose(5, 2), choose(0, 0)]).toEqual([
      1, 3, 0, 10, 1,
    ]);
  });

  it('pass/pass/fail at k = 3 is pass^3 = 0 and pass@3 = 1, with the pass rate beside them', () => {
    const side = sideOf([trial(true), trial(true), trial(false)], 3);
    expect(side).toMatchObject({ n: 3, s: 2, passK: 0, passAtK: 1, thin: false });
    expect(side.passRate).toBeCloseTo(2 / 3);
  });

  it('three of three passing is pass^3 = 1; none passing is pass@3 = 0', () => {
    expect(sideOf([trial(true), trial(true), trial(true)], 3)).toMatchObject({
      passK: 1,
      passAtK: 1,
    });
    expect(sideOf([trial(false), trial(false), trial(false)], 3)).toMatchObject({
      passK: 0,
      passAtK: 0,
    });
  });

  it('unequal n: five trials with four passes at k = 3', () => {
    const side = sideOf([trial(true), trial(true), trial(true), trial(true), trial(false)], 3);
    expect(side.passK).toBeCloseTo(4 / 10);
    expect(side.passAtK).toBeCloseTo(1);
  });

  it('a side under k trials is thin and has no estimator', () => {
    expect(sideOf([trial(true), trial(true)], 3)).toMatchObject({
      thin: true,
      passK: null,
      passAtK: null,
      passRate: 1,
    });
    expect(sideOf([], 3)).toMatchObject({ n: 0, thin: true, passRate: null, medianSeconds: null });
  });

  it('medians of seconds and calls, and the modes tallied', () => {
    const side = sideOf(
      [trial(true, { seconds: 5 }), trial(false, { seconds: 20 }), trial(false, { seconds: 9 })],
      3,
    );
    expect(side.medianSeconds).toBe(9);
    expect(side.medianCalls).toBe(2);
    expect(side.modes).toEqual({ unanswered: 2 });
    expect(median([4, 1])).toBe(2.5);
  });
});

describe('compare', () => {
  const before = file(
    { commit: 'aaa', model: 'm1' },
    { a: [trial(true), trial(true), trial(false)], b: [trial(false)] },
  );
  const after = file(
    { commit: 'bbb', model: 'm2', api: 'https://other' },
    { a: [trial(true), trial(true), trial(true)], c: [trial(true)] },
  );

  it('names what separates the two files', () => {
    expect(compare(before, after).differences).toEqual(
      [
        'commit: aaa → bbb',
        'api: https://beta → https://other',
        'model: m1 → m2',
        'trials: 4 → 4'.replace('trials: 4 → 4', ''),
      ].filter(Boolean),
    );
  });

  it('holds every task of either side, with null for the side that lacks it', () => {
    const c = compare(before, after);
    expect(c.tasks.map((t) => [t.id, t.before === null, t.after === null])).toEqual([
      ['a', false, false],
      ['b', false, true],
      ['c', true, false],
    ]);
  });

  it('holds no composite key and prints no total line', () => {
    const c = compare(before, after);
    expect(Object.keys(c).sort()).toEqual(['agreement', 'differences', 'k', 'tasks']);
    for (const task of c.tasks) {
      expect(Object.keys(task).sort()).toEqual(['after', 'before', 'id']);
      for (const side of [task.before, task.after]) {
        if (side) expect(Object.keys(side)).not.toContain('score');
      }
    }
    const lines = compareLines(c);
    expect(lines.some((l) => /total|overall|score/i.test(l))).toBe(false);
    expect(lines[0]).toBe('a');
    expect(lines[1]).toBe('  before: pass^3 0% · pass@3 100% · 2/3 trials passed');
    expect(lines[3]).toBe('  after: pass^3 100% · pass@3 100% · 3/3 trials passed');
    expect(lines.find((l) => l.includes('thin'))).toContain('(thin: 1 < 3)');
    expect(lines.at(-1)).toContain('differences: commit: aaa → bbb');
  });

  it('reports no differences for the same build', () => {
    expect(compareLines(compare(before, before)).at(-1)).toBe(
      'differences: none (same commit, api, model, judge, k and trial count)',
    );
  });
});

describe('the judge beside the estimators', () => {
  const judged = (pass: boolean, served: 'yes' | 'partial' | 'no'): TrialResult => {
    const t = trial(pass);
    const turn = t.turns[0];
    if (!turn) throw new Error('fixture has no turn');
    return { ...t, turns: [{ ...turn, judge: { intent: 'i', served, reason: 'r', quote: '' } }] };
  };
  const plain = file({}, { a: [trial(true), trial(true), trial(false)] });
  const withJudge = file(
    { judge: { model: 'j' } },
    { a: [judged(true, 'yes'), judged(true, 'partial'), judged(false, 'no')] },
  );

  it('tallies verdicts per side and agreement per file, leaving s, n, the estimators and modes untouched', () => {
    const c = compare(plain, withJudge);
    const a = c.tasks[0];
    expect(a?.before?.judge).toBeNull();
    expect(a?.after?.judge).toEqual({ judged: 3, yes: 1, partial: 1, no: 1, unreadable: 0 });
    for (const key of ['s', 'n', 'passRate', 'passK', 'passAtK', 'modes', 'thin'] as const)
      expect(a?.after?.[key]).toEqual(a?.before?.[key]);
    expect(c.agreement).toEqual({
      before: null,
      after: { ruleFailed: { judged: 1, no: 1 }, clean: { judged: 2, yes: 1 } },
    });
  });

  it('prints the judge line and the agreement line for the judged side only, and no weighted line', () => {
    const lines = compareLines(compare(plain, withJudge));
    expect(lines.filter((l) => l.includes('judge yes'))).toEqual([
      '    judge yes 1/3, partial 1/3, no 1/3, unreadable 0/3',
    ]);
    expect(lines.filter((l) => l.startsWith('before agreement'))).toEqual([]);
    expect(lines).toContain(
      'after agreement: rule-failed rows judged no 1/1, clean rows judged yes 1/2',
    );
    expect(lines.some((l) => /weighted|total|overall|score/i.test(l))).toBe(false);
    expect(lines.at(-1)).toBe('differences: judge: null → j');
  });

  it('a file with every judge key stripped reads to the same estimators', () => {
    const stripped = JSON.parse(JSON.stringify(withJudge)) as BenchResult;
    delete stripped.judge;
    for (const t of stripped.tasks)
      for (const tr of t.trials) for (const turn of tr.turns) delete turn.judge;
    const c = compare(withJudge, stripped);
    const a = c.tasks[0];
    expect([a?.before?.s, a?.before?.n, a?.before?.passK]).toEqual([
      a?.after?.s,
      a?.after?.n,
      a?.after?.passK,
    ]);
    expect(a?.after?.judge).toBeNull();
  });
});
