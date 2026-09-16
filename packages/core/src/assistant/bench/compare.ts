/**
 * ISS-1051 — two result files side by side, per task: how many trials, how many passed whole,
 * pass^k and pass@k as estimators over the trials observed, medians, and the failure modes tallied.
 * No composite exists here: a weighted mean is where the task that cliffs goes to hide.
 */

import type { BenchResult, TrialResult } from './result.js';

export interface TaskSide {
  n: number;
  /** Trials whose every turn passed. */
  s: number;
  passRate: number | null;
  /** P(all k of k sampled trials pass) = C(s,k)/C(n,k); null where n < k. */
  passK: number | null;
  /** P(at least one of k sampled trials passes) = 1 − C(n−s,k)/C(n,k); null where n < k. */
  passAtK: number | null;
  thin: boolean;
  medianSeconds: number | null;
  medianCalls: number | null;
  modes: Record<string, number>;
}

export interface TaskComparison {
  id: string;
  before: TaskSide | null;
  after: TaskSide | null;
}

export interface Comparison {
  k: number;
  tasks: TaskComparison[];
  differences: string[];
}

/** C(n, k) as a number; 0 where k > n. */
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 1; i <= k; i += 1) out = (out * (n - k + i)) / i;
  return Math.round(out);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const trialCalls = (trial: TrialResult): number =>
  trial.turns.reduce((sum, t) => sum + t.attempts.reduce((s, a) => s + a.calls, 0), 0);

export function sideOf(trials: TrialResult[], k: number): TaskSide {
  const n = trials.length;
  const s = trials.filter((t) => t.pass).length;
  const thin = n < k;
  const modes: Record<string, number> = {};
  for (const trial of trials) {
    for (const turn of trial.turns) {
      for (const mode of turn.modes) modes[mode] = (modes[mode] ?? 0) + 1;
    }
  }
  return {
    n,
    s,
    passRate: n === 0 ? null : s / n,
    passK: thin ? null : choose(s, k) / choose(n, k),
    passAtK: thin ? null : 1 - choose(n - s, k) / choose(n, k),
    thin,
    medianSeconds: median(trials.map((t) => t.seconds)),
    medianCalls: median(trials.map(trialCalls)),
    modes,
  };
}

function differences(before: BenchResult, after: BenchResult): string[] {
  const out: string[] = [];
  const pairs: Array<[string, unknown, unknown]> = [
    ['commit', before.commit, after.commit],
    ['api', before.api, after.api],
    ['model', before.model, after.model],
    ['k', before.k, after.k],
  ];
  for (const [name, a, b] of pairs) {
    if (a !== b) out.push(`${name}: ${String(a)} → ${String(b)}`);
  }
  const count = (r: BenchResult): number => r.tasks.reduce((sum, t) => sum + t.trials.length, 0);
  if (count(before) !== count(after)) out.push(`trials: ${count(before)} → ${count(after)}`);
  return out;
}

/** The two files compared per task; `k` is the after file's unless the before file names a larger one. */
export function compare(before: BenchResult, after: BenchResult): Comparison {
  const k = Math.max(before.k, after.k);
  const ids = [...new Set([...before.tasks, ...after.tasks].map((t) => t.id))];
  const tasks = ids.map((id) => {
    const b = before.tasks.find((t) => t.id === id);
    const a = after.tasks.find((t) => t.id === id);
    return { id, before: b ? sideOf(b.trials, k) : null, after: a ? sideOf(a.trials, k) : null };
  });
  return { k, tasks, differences: differences(before, after) };
}

const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);
const num = (v: number | null): string => (v === null ? '—' : v.toFixed(1));

function sideLines(label: string, side: TaskSide | null, k: number): string[] {
  if (!side) return [`  ${label}: no trials`];
  const thin = side.thin ? ` (thin: ${side.n} < ${k})` : '';
  const modes = Object.entries(side.modes)
    .sort((x, y) => y[1] - x[1])
    .map(([m, c]) => `${m}×${c}`)
    .join(', ');
  return [
    `  ${label}: pass^${k} ${pct(side.passK)} · pass@${k} ${pct(side.passAtK)} · ${side.s}/${side.n} trials passed${thin}`,
    `    median ${num(side.medianSeconds)}s · ${num(side.medianCalls)} calls${modes ? ` · modes ${modes}` : ''}`,
  ];
}

/** The comparison as lines for a terminal; there is no total line to print. */
export function compareLines(c: Comparison): string[] {
  const lines: string[] = [];
  for (const task of c.tasks) {
    lines.push(
      task.id,
      ...sideLines('before', task.before, c.k),
      ...sideLines('after', task.after, c.k),
    );
  }
  lines.push(
    c.differences.length === 0
      ? 'differences: none (same commit, api, model, k and trial count)'
      : `differences: ${c.differences.join('; ')}`,
  );
  return lines;
}
