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
  /** The project this run was taken against; `null` on a file written before ISS-1066 recorded one. */
  projectSlug: string | null;
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
  /** Tasks this project could not be asked, each with its reason; charged to no denominator (ISS-1066). */
  notApplicable: Array<{ id: string; why: string }>;
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

/** The project slug a row is grouped under; a file that names none stands in its own group. */
const slugOf = (result: BenchResult): string | null => result.project?.slug ?? null;

/**
 * Every run file ranked best first, GROUPED BY PROJECT: a task's pass rate is about the project it
 * was walked on. `k` is computed inside each group and never across them, or a three-trial run of
 * one project is marked thin and loses its score because another project's file named a larger
 * one (codex F3 on ISS-1066).
 */
export function rankRuns(
  files: Array<{ name: string; result: BenchResult }>,
  shipped: string[] = loadTasks().map((t) => t.id),
): RunRow[] {
  const order: Array<string | null> = [];
  for (const f of files) {
    const slug = slugOf(f.result);
    if (!order.includes(slug)) order.push(slug);
  }
  return order.flatMap((slug) =>
    rankGroup(
      files.filter((f) => slugOf(f.result) === slug),
      shipped,
    ),
  );
}

/** One project's files ranked against each other, at the largest `k` that group names. */
function rankGroup(
  files: Array<{ name: string; result: BenchResult }>,
  shipped: string[],
): RunRow[] {
  // cm:why one k for every file IN THE GROUP, the largest named, as compare.ts does: pass^k at k = 1 and at k = 3 are different figures, and a ladder that ranked one against the other would order builds by their k, not their passes (codex F1)
  const k = Math.max(1, ...files.map((f) => f.result.k));
  return files
    .map(({ name, result }) => {
      const applicable = result.tasks.filter((t) => t.notApplicable === undefined);
      const sides = applicable.map((t) => ({ id: t.id, side: sideOf(t.trials, k) }));
      const walked = new Set(result.tasks.map((t) => t.id));
      const s = score(sides);
      return {
        name,
        projectSlug: slugOf(result),
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
        // cm:guard a task the project cannot be asked is not a thin one: `0/0 trials (thin)` marked the whole run thin on a run that walked every applicable task three times (ISS-1066)
        thin: sides.some((x) => x.side.thin),
        notApplicable: result.tasks.flatMap((t) =>
          t.notApplicable ? [{ id: t.id, why: t.notApplicable }] : [],
        ),
        judgeServed: judgeServedOf(result),
        medianSeconds: median(applicable.flatMap((t) => t.trials.map((trial) => trial.seconds))),
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

/** The rows of one project at a time, in the order `rankRuns` put them, so each gets its own table. */
export function groupByProject(runs: RunRow[]): Array<{ slug: string | null; rows: RunRow[] }> {
  const groups: Array<{ slug: string | null; rows: RunRow[] }> = [];
  for (const row of runs) {
    const last = groups.at(-1);
    if (last && last.slug === row.projectSlug) last.rows.push(row);
    else groups.push({ slug: row.projectSlug, rows: [row] });
  }
  return groups;
}

const projectHeading = (slug: string | null): string =>
  slug === null ? 'runs (project not recorded)' : `runs · project ${slug}`;

/** The ladder for a terminal: one run table per project under its own score definition, then the windows. */
export function ladderLines(runs: RunRow[], windows: WindowRow[]): string[] {
  const lines: string[] = [];
  // cm:guard one table, one score definition and one delta PER PROJECT: a task's pass rate is about
  // the project it was walked on, so a single ladder over two projects ranks two questions (ISS-1066)
  for (const group of groupByProject(runs)) {
    lines.push(
      projectHeading(group.slug),
      ...table(RUN_HEAD, group.rows.map(runCells)),
      scoreDefinition(group.rows[0]?.k ?? 1),
    );
    const d = deltaLine(group.rows);
    if (d) lines.push(d);
    for (const row of group.rows)
      for (const n of row.notApplicable)
        lines.push(`${row.name}: ${n.id} not applicable — ${n.why}`);
    const caps = capabilityTable(group.rows);
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

// cm:why a backslash is escaped before the pipe: escaping only the pipe leaves `\\|` readable as an escaped backslash followed by a live pipe, which splits the cell (CodeQL js/incomplete-sanitization)
export const mdCell = (c: string): string => c.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
const mdRow = (cells: string[]): string => `| ${cells.map(mdCell).join(' | ')} |`;
const mdTable = (head: string[], rows: string[][]): string[] => [
  mdRow(head),
  `|${head.map(() => '---').join('|')}|`,
  ...rows.map(mdRow),
];

/** The same ladder as Markdown, for an issue comment; one section per project, as above. */
export function ladderMarkdown(runs: RunRow[], windows: WindowRow[]): string {
  const parts: string[] = [];
  for (const group of groupByProject(runs)) {
    parts.push(
      `### ${projectHeading(group.slug)}`,
      '',
      ...mdTable(RUN_HEAD, group.rows.map(runCells)),
      '',
      `_${scoreDefinition(group.rows[0]?.k ?? 1)}_`,
    );
    const d = deltaLine(group.rows);
    if (d) parts.push('', d);
    for (const row of group.rows)
      for (const n of row.notApplicable)
        parts.push('', `${row.name}: ${n.id} not applicable — ${n.why}`);
    const caps = capabilityTable(group.rows);
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
