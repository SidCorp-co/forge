/**
 * ISS-1053 - rows and their grades, summarized per model and source as counts and the rates they
 * come from, with medians and the rows that carried a mode. Rates, not pass^k: a row is not a
 * trial (D2). The benchmark's own rooms are dropped first, by session id (D4).
 */

import { median } from '../compare.js';
import type { Evidence, FailureMode } from '../grade.js';
import { readAttempt } from '../trail.js';
import { HISTORY_MODES, type RowGrade } from './grade-row.js';
import type { HistoryRow } from './row.js';

export const THIN_ROWS = 30;

export interface ModeTally {
  count: number;
  /** count / rows; null where the group has no row. */
  rate: number | null;
}

export interface Group {
  model: string;
  source: string;
  rows: number;
  sessions: number;
  thin: boolean;
  modes: Record<FailureMode, ModeTally>;
  medians: { ms: number | null; calls: number | null; iterations: number | null };
}

export interface FlaggedRow {
  chatLogId: string;
  sessionId: string | null;
  createdAt: string;
  model: string;
  source: string;
  modes: FailureMode[];
  evidence: Evidence[];
}

export interface Summary {
  excludedRows: number;
  groups: Group[];
  flagged: FlaggedRow[];
}

export type Graded = { row: HistoryRow; grade: RowGrade };

const NONE = '(none)';
const keyOf = (row: HistoryRow): string => `${row.model ?? NONE} ${row.source ?? NONE}`;

function emptyTallies(): Record<FailureMode, ModeTally> {
  const out = {} as Record<FailureMode, ModeTally>;
  for (const mode of HISTORY_MODES) out[mode] = { count: 0, rate: null };
  return out;
}

function groupOf(rows: Graded[]): Group {
  const first = rows[0]?.row;
  const modes = emptyTallies();
  for (const { grade } of rows) {
    for (const mode of grade.modes) {
      const tally = modes[mode] ?? { count: 0, rate: null };
      tally.count += 1;
      modes[mode] = tally;
    }
  }
  for (const tally of Object.values(modes))
    tally.rate = rows.length === 0 ? null : tally.count / rows.length;
  const attempts = rows.map(({ row }) => readAttempt(row));
  return {
    model: first?.model ?? NONE,
    source: first?.source ?? NONE,
    rows: rows.length,
    sessions: new Set(rows.map(({ row }) => row.sessionId ?? row.id)).size,
    thin: rows.length < THIN_ROWS,
    modes,
    medians: {
      ms: median(attempts.map((a) => a.ms)),
      calls: median(attempts.map((a) => a.calls.length)),
      iterations: median(attempts.map((a) => a.iterations)),
    },
  };
}

/** Group, tally and flag; `excluded` holds the bench rooms' session ids. */
export function summarize(graded: Graded[], excluded: ReadonlySet<string> = new Set()): Summary {
  const kept = graded.filter(({ row }) => !(row.sessionId && excluded.has(row.sessionId)));
  const byKey = new Map<string, Graded[]>();
  for (const item of kept) {
    const key = keyOf(item.row);
    byKey.set(key, [...(byKey.get(key) ?? []), item]);
  }
  const groups = [...byKey.values()]
    .map(groupOf)
    .sort(
      (a, b) =>
        b.rows - a.rows || a.model.localeCompare(b.model) || a.source.localeCompare(b.source),
    );
  const flagged = kept
    .filter(({ grade }) => grade.modes.length > 0)
    .sort(
      (a, b) => b.row.createdAt.localeCompare(a.row.createdAt) || b.row.id.localeCompare(a.row.id),
    )
    .map(({ row, grade }) => ({
      chatLogId: row.id,
      sessionId: row.sessionId,
      createdAt: row.createdAt,
      model: row.model ?? NONE,
      source: row.source ?? NONE,
      modes: grade.modes,
      evidence: grade.evidence,
    }));
  return { excludedRows: graded.length - kept.length, groups, flagged };
}
