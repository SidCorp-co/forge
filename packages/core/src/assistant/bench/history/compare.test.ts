/**
 * ISS-1053 - two history files side by side: every rate beside its count, a group present on one
 * side only, what separates the windows, and no total line.
 */

import { describe, expect, it } from 'vitest';
import { compareHistory, compareHistoryLines } from './compare.js';
import type { HistoryResult } from './result.js';
import type { Group } from './summarize.js';

const group = (
  model: string,
  rows: number,
  unanswered: number,
  over: Partial<Group> = {},
): Group => ({
  model,
  source: 'web-chat-reply',
  rows,
  sessions: Math.max(1, Math.round(rows / 2)),
  thin: rows < 30,
  modes: {
    fallback_sent: { count: 0, rate: 0 },
    unanswered: { count: unanswered, rate: unanswered / rows },
    screen_repair: { count: 0, rate: 0 },
    help_roundtrip: { count: 0, rate: 0 },
    placeholder_argument: { count: 0, rate: 0 },
    repeated_call: { count: 0, rate: 0 },
    wrong_link_shape: { count: 0, rate: 0 },
    dead_link: { count: 0, rate: 0 },
    language_mismatch: { count: 0, rate: 0 },
    over_budget: { count: 0, rate: 0 },
  } as Group['modes'],
  medians: { ms: 4000, calls: 2, iterations: 2 },
  ...over,
});

const file = (over: Partial<HistoryResult>, groups: Group[]): HistoryResult => ({
  at: 'now',
  api: 'https://api.test',
  commit: 'aaa',
  version: '0.3.0',
  window: { projectSlug: 'qa', from: '2026-09-01', to: '2026-09-08', source: null },
  budgetSeconds: 60,
  maxIterations: 8,
  resolved: false,
  excludedSessions: [],
  excludedSessionsByTask: [],
  excludedRowsByTask: 0,
  excludedRows: 0,
  groups,
  flagged: [],
  ...over,
});

/** The differences line, the last one before the advice block. */
const differencesLine = (lines: string[]): string | undefined =>
  lines.find((l) => l.startsWith('differences:') || l.startsWith('no differences:'));

describe('compareHistory', () => {
  const before = file({}, [group('m1', 40, 4), group('m0', 5, 1)]);
  const after = file(
    {
      commit: 'bbb',
      window: { projectSlug: 'qa', from: '2026-09-08', to: '2026-09-16', source: null },
      resolved: true,
    },
    [group('m1', 50, 2), group('m2', 10, 0)],
  );

  it("ends with the after file's advice, per group, and the lines before it are the comparison unchanged", () => {
    const g = after.groups[0];
    if (!g) throw new Error('fixture');
    const row = { chatLogId: 'l', sessionId: null, createdAt: 'x', evidence: [] };
    const flagged = {
      ...after,
      flagged: [
        { ...row, model: g.model, source: g.source, modes: ['unanswered' as const] },
        { ...row, model: 'nobody', source: g.source, modes: ['unanswered' as const] },
      ],
    };
    const c = compareHistory(before, flagged);
    const lines = compareHistoryLines(c);
    const at = lines.indexOf('advice:');
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toContain('differences: commit: aaa -> bbb');
    expect(lines.slice(at + 1)).toEqual([
      `  ${g.model} / ${g.source}: unanswered 1/${g.rows} (${Math.round(100 / g.rows)}%) above 0 -> conversations/turn-runner.ts: the door lets a provider error or an empty reply reach the person; retry once or say so`,
    ]);
    expect(c.advice.map((a) => a.label)).toEqual(
      after.groups.map((g) => `${g.model} / ${g.source}`),
    );
    expect(lines.slice(0, at)).toEqual(compareHistoryLines({ ...c, advice: [] }).slice(0, -1));
    expect(compareHistoryLines(compareHistory(before, after)).at(-1)).toBe(
      'advice: none - every pattern is under its threshold',
    );
  });

  it('pairs groups by model and source, null where a side lacks one', () => {
    const c = compareHistory(before, after);
    expect(c.groups.map((g) => [g.model, g.before?.rows ?? null, g.after?.rows ?? null])).toEqual([
      ['m1', 40, 50],
      ['m0', 5, null],
      ['m2', null, 10],
    ]);
  });

  it('names what separates the files', () => {
    expect(compareHistory(before, after).differences).toEqual([
      'commit: aaa -> bbb',
      'window: qa 2026-09-01..2026-09-08 -> qa 2026-09-08..2026-09-16',
      'resolved: false -> true',
      'rows: 45 -> 60',
    ]);
    expect(compareHistory(before, before).differences).toEqual([]);
  });

  it('prints every rate beside its count, marks thin, and prints no total', () => {
    const lines = compareHistoryLines(compareHistory(before, after));
    expect(lines[0]).toBe('m1 / web-chat-reply');
    expect(lines[1]).toBe(
      '  before: 40 rows in 20 sessions; median 4000.0ms, 2.0 calls, 2.0 iterations',
    );
    expect(lines[2]).toBe('    unanswered 4/40 (10.0%)');
    expect(lines[4]).toBe('    unanswered 2/50 (4.0%)');
    expect(lines.find((l) => l.includes('thin'))).toContain('(thin: 5 < 30)');
    expect(lines.find((l) => l.startsWith('  after: no rows'))).toBeDefined();
    expect(lines.some((l) => /total|overall|score/i.test(l))).toBe(false);
    expect(differencesLine(lines)).toBe(
      'differences: commit: aaa -> bbb; window: qa 2026-09-01..2026-09-08 -> qa 2026-09-08..2026-09-16; resolved: false -> true; rows: 45 -> 60',
    );
  });

  it('says so when nothing separates the files', () => {
    expect(differencesLine(compareHistoryLines(compareHistory(before, before)))).toBe(
      'no differences: same commit, window, budgets, judge and row count',
    );
    const clean = file({}, [group('m9', 10, 0)]);
    expect(compareHistoryLines(compareHistory(clean, clean))).toContain('    no mode on any row');
  });
});

describe('the judge beside the rates', () => {
  const plain = file({}, [group('m1', 40, 4)]);
  const judged = file(
    {
      judge: {
        model: 'j',
        sample: 40,
        rows: [],
        groups: [
          {
            model: 'm1',
            source: 'web-chat-reply',
            tally: { judged: 10, yes: 7, partial: 2, no: 1, unreadable: 0 },
          },
        ],
        agreement: { ruleFailed: { judged: 2, no: 2 }, clean: { judged: 5, yes: 4 } },
      },
    },
    [group('m1', 40, 4)],
  );

  it('prints the judge line under the judged side only, one agreement line, and names the judge in the differences', () => {
    const lines = compareHistoryLines(compareHistory(plain, judged));
    expect(lines.filter((l) => l.includes('judge yes'))).toEqual([
      '    judge yes 7/10, partial 2/10, no 1/10, unreadable 0/10',
    ]);
    expect(
      lines.indexOf('    judge yes 7/10, partial 2/10, no 1/10, unreadable 0/10'),
    ).toBeGreaterThan(lines.findIndex((l) => l.startsWith('  after:')));
    expect(lines.filter((l) => l.startsWith('before judge'))).toEqual([]);
    expect(lines).toContain(
      'after judge j, 0 of 40 asked: agreement: rule-failed rows judged no 2/2, clean rows judged yes 4/5',
    );
    expect(differencesLine(lines)).toBe('differences: judge: null -> j');
    expect(lines.some((l) => /weighted|total|overall|score/i.test(l))).toBe(false);
  });

  it('a file without a judge prints no judge line at all', () => {
    const lines = compareHistoryLines(compareHistory(plain, plain));
    expect(
      lines
        .slice(0, lines.indexOf('advice:'))
        .filter((l) => !l.startsWith('no differences:'))
        .some((l) => l.includes('judge')),
    ).toBe(false);
  });
});
