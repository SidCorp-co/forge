/**
 * ISS-1053 — one `chat_logs` row graded on what a row alone can show. The benchmark's graders do
 * the work through a synthetic turn of the checks that need no task expectation (D1); the three
 * rules history alone has — a repair row by its corrective query, an error row, a Vietnamese
 * question answered with no Vietnamese word — live here beside them.
 */

import { CORRECTIVE_PREFIX } from '../../../conversations/fallback-replies.js';
import {
  type Evidence,
  type FailureMode,
  gradeTurn,
  type LinkOutcome,
  vietnameseWords,
} from '../grade.js';
import type { Check } from '../task.js';
import { readAttempt } from '../trail.js';
import type { HistoryRow } from './row.js';

export interface GradeRowOptions {
  /** A row slower than this is `over_budget`. */
  budgetSeconds: number;
  /** A row with more iterations than this is `over_budget`. */
  maxIterations: number;
  /** Outcomes for the UUID links the reply carries; absent, links are not judged for resolution. */
  lookups?: Record<string, LinkOutcome>;
}

export interface RowGrade {
  modes: FailureMode[];
  evidence: Evidence[];
}

/** The modes a row can be named by; `summarize.ts` tallies over exactly these. */
export const HISTORY_MODES: readonly FailureMode[] = [
  'fallback_sent',
  'unanswered',
  'screen_repair',
  'help_roundtrip',
  'placeholder_argument',
  'repeated_call',
  'wrong_link_shape',
  'dead_link',
  'language_mismatch',
  'over_budget',
];

const VI_QUERY_WORDS = 3;

function checksFor(opts: GradeRowOptions): Check[] {
  const checks: Check[] = [
    { kind: 'linkShape' },
    { kind: 'notFallback' },
    { kind: 'noHelp' },
    { kind: 'noPlaceholder' },
    { kind: 'noRepeatedCall' },
    { kind: 'maxIterations', max: opts.maxIterations },
    { kind: 'maxSeconds' },
  ];
  if (opts.lookups) checks.push({ kind: 'linksResolve' });
  return checks;
}

/** A row's grade: the benchmark's checks over the row, plus history's three rules. */
export function gradeRow(row: HistoryRow, opts: GradeRowOptions): RowGrade {
  const attempt = readAttempt(row);
  const grade = gradeTurn(
    { message: row.query ?? '', checks: checksFor(opts) },
    {
      delivered: row.reply?.trim() ? row.reply : null,
      attempts: [attempt],
      seconds: attempt.ms / 1000,
      budgetSeconds: opts.budgetSeconds,
      values: {},
      lookups: opts.lookups ?? {},
      preferenceRows: [],
    },
  );
  const evidence: Evidence[] = [...grade.evidence];
  if (row.error) evidence.push({ mode: 'unanswered', fact: `error: ${row.error.slice(0, 120)}` });
  if ((row.query ?? '').startsWith(CORRECTIVE_PREFIX))
    evidence.push({
      mode: 'screen_repair',
      fact: "the query is the door's corrective instruction: a retry row",
    });
  const queryVi = vietnameseWords(row.query ?? '');
  if (queryVi >= VI_QUERY_WORDS && row.reply && vietnameseWords(row.reply) === 0)
    evidence.push({
      mode: 'language_mismatch',
      fact: `${queryVi} Vietnamese-marked words in the question, none in the reply`,
    });
  return { modes: [...new Set(evidence.map((e) => e.mode))], evidence };
}
