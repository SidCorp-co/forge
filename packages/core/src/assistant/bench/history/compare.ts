/**
 * ISS-1053 - two history files side by side, per model and source: rates beside the counts they
 * come from, medians, and what separates the windows. No total line: a window is not a score.
 */

import { type AdviceInput, adviceInputsOfHistory, adviceLines, advise } from '../advice.js';
import type { FailureMode } from '../grade.js';
import { agreementLine, tallyLine } from '../judge.js';
import type { HistoryJudge, HistoryResult, JudgeGroup } from './result.js';
import type { Group, ModeTally } from './summarize.js';

export interface GroupComparison {
  model: string;
  source: string;
  before: Group | null;
  after: Group | null;
  /** The judge's counts for this group on each side; null where that file had none. */
  judge: { before: JudgeGroup | null; after: JudgeGroup | null };
}

export interface HistoryComparison {
  groups: GroupComparison[];
  /** Each file's judge block, for the agreement lines; null where the file had none. */
  judge: { before: HistoryJudge | null; after: HistoryJudge | null };
  differences: string[];
  /** The after file's counts per group, for the advice block. */
  advice: AdviceInput[];
}

const windowOf = (r: HistoryResult): string =>
  `${r.window.projectSlug} ${r.window.from}..${r.window.to}${r.window.source ? ` source=${r.window.source}` : ''}`;
const rowsOf = (r: HistoryResult): number => r.groups.reduce((sum, g) => sum + g.rows, 0);

function differences(before: HistoryResult, after: HistoryResult): string[] {
  const out: string[] = [];
  const pairs: Array<[string, unknown, unknown]> = [
    ['commit', before.commit, after.commit],
    ['window', windowOf(before), windowOf(after)],
    ['budget seconds', before.budgetSeconds, after.budgetSeconds],
    ['max iterations', before.maxIterations, after.maxIterations],
    ['resolved', before.resolved, after.resolved],
    ['judge', before.judge?.model ?? null, after.judge?.model ?? null],
    ['rows', rowsOf(before), rowsOf(after)],
  ];
  for (const [name, a, b] of pairs) {
    if (a !== b) out.push(`${name}: ${String(a)} -> ${String(b)}`);
  }
  return out;
}

/** Every group present on either side, paired by model and source. */
export function compareHistory(before: HistoryResult, after: HistoryResult): HistoryComparison {
  const key = (g: Group): string => `${g.model} ${g.source}`;
  const keys = [...new Set([...before.groups, ...after.groups].map(key))];
  const groups = keys.flatMap((k) => {
    const b = before.groups.find((g) => key(g) === k) ?? null;
    const a = after.groups.find((g) => key(g) === k) ?? null;
    const any = b ?? a;
    if (!any) return [];
    const judgeOf = (r: HistoryResult): JudgeGroup | null =>
      r.judge?.groups.find((jg) => `${jg.model} ${jg.source}` === k) ?? null;
    return [
      {
        model: any.model,
        source: any.source,
        before: b,
        after: a,
        judge: { before: judgeOf(before), after: judgeOf(after) },
      },
    ];
  });
  return {
    groups,
    judge: { before: before.judge ?? null, after: after.judge ?? null },
    differences: differences(before, after),
    advice: adviceInputsOfHistory(after),
  };
}

const pct = (v: number | null): string => (v === null ? '-' : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null): string => (v === null ? '-' : v.toFixed(1));

function sideLines(label: string, g: Group | null, judge: JudgeGroup | null): string[] {
  if (!g) return [`  ${label}: no rows`];
  const modes = (Object.entries(g.modes) as Array<[FailureMode, ModeTally]>)
    .filter(([, t]) => t.count > 0)
    .sort((x, y) => y[1].count - x[1].count)
    .map(([m, t]) => `${m} ${t.count}/${g.rows} (${pct(t.rate)})`)
    .join(', ');
  const thin = g.thin ? ` (thin: ${g.rows} < 30)` : '';
  return [
    `  ${label}: ${g.rows} rows in ${g.sessions} sessions${thin}; median ${num(g.medians.ms)}ms, ${num(g.medians.calls)} calls, ${num(g.medians.iterations)} iterations`,
    `    ${modes || 'no mode on any row'}`,
    ...(judge ? [`    ${tallyLine(judge.tally)}`] : []),
  ];
}

/** Lines for a terminal: every rate beside its count, and no total. */
export function compareHistoryLines(c: HistoryComparison): string[] {
  const lines: string[] = [];
  for (const g of c.groups) {
    lines.push(
      `${g.model} / ${g.source}`,
      ...sideLines('before', g.before, g.judge.before),
      ...sideLines('after', g.after, g.judge.after),
    );
  }
  for (const side of ['before', 'after'] as const) {
    const j = c.judge[side];
    if (j)
      lines.push(
        `${side} judge ${j.model}, ${j.rows.length} of ${j.sample} asked: ${agreementLine(j.agreement)}`,
      );
  }
  lines.push(
    c.differences.length === 0
      ? 'no differences: same commit, window, budgets, judge and row count'
      : `differences: ${c.differences.join('; ')}`,
  );
  lines.push(...adviceLines(advise(c.advice)));
  return lines;
}
