/**
 * ISS-1059 — one ranked ladder over benchmark run files and history windows. The score is defined
 * once here and printed with every ladder; the lowest task stands on the same row as every score
 * so a task that cliffs cannot hide behind a mean, and the judge's served rate is a column that
 * never enters the score. Reverses ISS-1051's "no composite" on the owner's word of 2026-09-16.
 */

import { type CapabilitySummary, passKMean } from './capability.js';
import { capabilitiesOf, median, sideOf, type TaskSide } from './compare.js';
import type { HistoryResult } from './history/result.js';
import { isVerdict } from './judge.js';
import type { BenchResult } from './result.js';
import { loadTasks } from './tasks/index.js';

/** The definition printed under every run table; `k` is the one every file's sides were taken at. */
export const scoreDefinition = (k: number): string =>
  `score = mean of pass^k over the tasks walked at k = ${k}, 0-100; tie: the lowest task; the judge is a column, never in the score`;

export interface Lowest {
  id: string;
  passK: number | null;
}

export interface Rate {
  yes: number;
  judged: number;
}

export interface RunRow {
  name: string;
  /** The common k every side of every file was taken at: the largest k any file names. */
  k: number;
  commit: string | null;
  model: string | null;
  at: string;
  score: number | null;
  lowest: Lowest | null;
  /** Tasks whose pass^k is 1. */
  fullTasks: number;
  tasksWalked: number;
  tasksShipped: number;
  partial: boolean;
  thin: boolean;
  judgeServed: Rate | null;
  medianSeconds: number | null;
  /** The same score per capability the file's tasks carry (ISS-1061). */
  capabilities: CapabilitySummary[];
}

export interface WindowRow {
  name: string;
  commit: string | null;
  window: string;
  rows: number;
  sessions: number;
  thin: boolean;
  servedRate: Rate | null;
  flaggedRate: { flagged: number; rows: number };
}

/** The mean of pass^k over the sides that have one, 0–100 to one decimal, with the lowest task. */
export function score(sides: Array<{ id: string; side: TaskSide }>): {
  score: number | null;
  lowest: Lowest | null;
} {
  return passKMean(sides);
}

const judgeServedOf = (r: BenchResult): Rate | null => {
  const verdicts = r.tasks.flatMap((t) =>
    t.trials.flatMap((trial) => trial.turns.flatMap((turn) => (turn.judge ? [turn.judge] : []))),
  );
  if (verdicts.length === 0) return null;
  return {
    yes: verdicts.filter((v) => isVerdict(v) && v.served === 'yes').length,
    judged: verdicts.length,
  };
};

const byScore = (a: RunRow, b: RunRow): number =>
  (b.score ?? -1) - (a.score ?? -1) ||
  (b.lowest?.passK ?? -1) - (a.lowest?.passK ?? -1) ||
  a.name.localeCompare(b.name);

/** Every run file ranked best first; `shipped` defaults to the task set this build carries. */
export function rankRuns(
  files: Array<{ name: string; result: BenchResult }>,
  shipped: string[] = loadTasks().map((t) => t.id),
): RunRow[] {
  const k = Math.max(1, ...files.map((f) => f.result.k));
  return files
    .map(({ name, result }) => {
      const sides = result.tasks.map((t) => ({ id: t.id, side: sideOf(t.trials, k) }));
      const walked = new Set(sides.map((s) => s.id));
      const s = score(sides);
      return {
        name,
        k,
        commit: result.commit,
        model: result.model,
        at: result.at,
        score: s.score,
        lowest: s.lowest,
        fullTasks: sides.filter((x) => x.side.passK === 1).length,
        tasksWalked: sides.length,
        tasksShipped: shipped.length,
        partial: !shipped.every((id) => walked.has(id)),
        thin: sides.some((x) => x.side.thin),
        judgeServed: judgeServedOf(result),
        medianSeconds: median(result.tasks.flatMap((t) => t.trials.map((trial) => trial.seconds))),
        capabilities: capabilitiesOf(result, k),
      };
    })
    .sort(byScore);
}

const rateOf = (r: Rate | null): number => (r === null || r.judged === 0 ? -1 : r.yes / r.judged);

/** Every history file ranked by served rate, then by the fewest flagged rows. */
export function rankWindows(files: Array<{ name: string; result: HistoryResult }>): WindowRow[] {
  return files
    .map(({ name, result }) => {
      const rows = result.groups.reduce((sum, g) => sum + g.rows, 0);
      const judged = result.judge?.rows ?? [];
      return {
        name,
        commit: result.commit,
        window: `${result.window.projectSlug} ${result.window.from}..${result.window.to}`,
        rows,
        sessions: result.groups.reduce((sum, g) => sum + g.sessions, 0),
        thin: rows < 30,
        servedRate:
          judged.length === 0
            ? null
            : {
                yes: judged.filter((r) => isVerdict(r.judge) && r.judge.served === 'yes').length,
                judged: judged.length,
              },
        flaggedRate: { flagged: result.flagged.length, rows },
      };
    })
    .sort(
      (a, b) =>
        rateOf(b.servedRate) - rateOf(a.servedRate) ||
        a.flaggedRate.flagged / Math.max(1, a.flaggedRate.rows) -
          b.flaggedRate.flagged / Math.max(1, b.flaggedRate.rows) ||
        a.name.localeCompare(b.name),
    );
}

const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);
const rate = (r: Rate | null): string =>
  r === null ? '—' : `${pct(r.yes / Math.max(1, r.judged))} (${r.yes}/${r.judged})`;
const num = (v: number | null, unit = ''): string => (v === null ? '—' : `${v.toFixed(1)}${unit}`);
const short = (c: string | null): string => (c ? c.slice(0, 8) : '—');

const RUN_HEAD = [
  '#',
  'run',
  'commit',
  'model',
  'score',
  'lowest task',
  'full',
  'judge served',
  'median',
  'marks',
];
const WINDOW_HEAD = [
  '#',
  'window file',
  'commit',
  'window',
  'rows',
  'sessions',
  'served',
  'flagged',
  'marks',
];

function runCells(row: RunRow, i: number): string[] {
  const marks = [
    row.partial ? `partial (${row.tasksWalked} of ${row.tasksShipped} tasks)` : '',
    row.thin ? 'thin' : '',
  ].filter(Boolean);
  return [
    String(i + 1),
    row.name,
    short(row.commit),
    row.model ?? '—',
    num(row.score),
    row.lowest ? `${row.lowest.id} ${pct(row.lowest.passK)}` : '—',
    `${row.fullTasks}/${row.tasksWalked}`,
    rate(row.judgeServed),
    num(row.medianSeconds, 's'),
    marks.join(', ') || '—',
  ];
}

function windowCells(row: WindowRow, i: number): string[] {
  return [
    String(i + 1),
    row.name,
    short(row.commit),
    row.window,
    String(row.rows),
    String(row.sessions),
    rate(row.servedRate),
    `${row.flaggedRate.flagged}/${row.flaggedRate.rows}`,
    row.thin ? `thin (${row.rows} < 30)` : '—',
  ];
}

function table(head: string[], rows: string[][]): string[] {
  const width = head.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? '').length)));
  const line = (cells: string[]): string =>
    cells
      .map((cell, c) => cell.padEnd(width[c] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(head), ...rows.map(line)];
}

const delta = (a: number | null, b: number | null, unit = ''): string =>
  a === null || b === null ? '—' : `${a - b >= 0 ? '+' : ''}${(a - b).toFixed(1)}${unit}`;

/** The difference between the top two run rows, one figure per column that has one. */
export function deltaLine(runs: RunRow[]): string | null {
  const [first, second] = runs;
  if (!first || !second) return null;
  return `delta (1st over 2nd): score ${delta(first.score, second.score)}; lowest task ${pct(first.lowest?.passK ?? null)} vs ${pct(second.lowest?.passK ?? null)}; full tasks ${first.fullTasks - second.fullTasks >= 0 ? '+' : ''}${first.fullTasks - second.fullTasks}; judge served ${rate(first.judgeServed)} vs ${rate(second.judgeServed)}; median ${delta(first.medianSeconds, second.medianSeconds, 's')}`;
}

/** The capability columns every run row names, in the order the first row that has each names it. */
function capabilityNames(runs: RunRow[]): string[] {
  return [...new Set(runs.flatMap((r) => r.capabilities.map((c) => c.capability)))];
}

/** One row per run in ladder order: the score per capability, `—` where the run walked none of its tasks. */
function capabilityTable(runs: RunRow[]): { head: string[]; rows: string[][] } | null {
  const names = capabilityNames(runs);
  if (names.length === 0) return null;
  const cell = (r: RunRow, name: string): string => {
    const s = r.capabilities.find((c) => c.capability === name);
    return s
      ? `${num(s.score)} ${s.lowest ? `${s.lowest.id} ${pct(s.lowest.passK)}` : '—'} (${s.fullTasks}/${s.tasks.length} full)`
      : '—';
  };
  return {
    head: ['#', 'run', ...names],
    rows: runs.map((r, i) => [String(i + 1), r.name, ...names.map((n) => cell(r, n))]),
  };
}

/** The ladder for a terminal: the run table under its score definition, then the windows. */
export function ladderLines(runs: RunRow[], windows: WindowRow[]): string[] {
  const lines: string[] = [];
  if (runs.length > 0) {
    lines.push('runs', ...table(RUN_HEAD, runs.map(runCells)), scoreDefinition(runs[0]?.k ?? 1));
    const d = deltaLine(runs);
    if (d) lines.push(d);
    const caps = capabilityTable(runs);
    if (caps) lines.push('capabilities', ...table(caps.head, caps.rows));
  }
  if (windows.length > 0) {
    lines.push(
      'history windows',
      ...table(WINDOW_HEAD, windows.map(windowCells)),
      'served = judge yes over judged rows; flagged = rows carrying a mode over rows',
    );
  }
  return lines;
}

export const mdCell = (c: string): string => c.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
const mdRow = (cells: string[]): string => `| ${cells.map(mdCell).join(' | ')} |`;
const mdTable = (head: string[], rows: string[][]): string[] => [
  mdRow(head),
  `|${head.map(() => '---').join('|')}|`,
  ...rows.map(mdRow),
];

/** The same ladder as Markdown, for an issue comment. */
export function ladderMarkdown(runs: RunRow[], windows: WindowRow[]): string {
  const parts: string[] = [];
  if (runs.length > 0) {
    parts.push(
      '### Runs',
      '',
      ...mdTable(RUN_HEAD, runs.map(runCells)),
      '',
      `_${scoreDefinition(runs[0]?.k ?? 1)}_`,
    );
    const d = deltaLine(runs);
    if (d) parts.push('', d);
    const caps = capabilityTable(runs);
    if (caps) parts.push('', '### Capabilities', '', ...mdTable(caps.head, caps.rows));
  }
  if (windows.length > 0) {
    parts.push(
      '',
      '### History windows',
      '',
      ...mdTable(WINDOW_HEAD, windows.map(windowCells)),
      '',
      '_served = judge yes over judged rows; flagged = rows carrying a mode over rows_',
    );
  }
  return `${parts.join('\n').trim()}\n`;
}
