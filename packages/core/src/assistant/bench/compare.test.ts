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
    expect(Object.keys(c).sort()).toEqual(['differences', 'k', 'tasks']);
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
      'differences: none (same commit, api, model, k and trial count)',
    );
  });
});
