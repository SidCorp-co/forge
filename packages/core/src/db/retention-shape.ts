import { TERMINAL_JOB_STATUSES } from '@forge/contracts/job-machine';
import { type SQL, sql } from 'drizzle-orm';
import { terminalAgentSessionStatuses } from './session-vocabulary.js';

/** Terminal `jobs.status`, from the one constant that answers it. */
export const JOB_TERMINAL = sql`(${sql.join(
  TERMINAL_JOB_STATUSES.map((s) => sql`${s}`),
  sql`, `,
)})`;
/** Terminal `agent_sessions.status`, from the one constant that answers it. */
export const SESSION_TERMINAL = sql`(${sql.join(
  terminalAgentSessionStatuses.map((s) => sql`${s}`),
  sql`, `,
)})`;
/** Terminal `pipeline_runs.status`. */
export const RUN_TERMINAL = sql`('completed', 'failed', 'cancelled')`;
/**
 * Terminal `issues.status` (ISS-1107). `awaiting_release` is NOT here: the issue
 * is still moving there, and an audit row is kept while the thing it records can
 * still change.
 */
export const ISSUE_TERMINAL = sql`('closed', 'dropped')`;

export function olderThan(column: SQL, days: number): SQL {
  return sql`${column} < now() - make_interval(days => ${days})`;
}

/** What one table owes the sweep. */
export interface TableStatements {
  /** One bounded batch of deletions, returning the ids removed. */
  deleteBatch: (days: number, limit: number) => SQL;
  /**
   * Rows past the window that this table's rule EXEMPTS — the negation of the
   * same predicate the delete selects on, so the figure means "what the rule
   * keeps" and nothing else. It is deliberately not "what is left past the
   * window": that answer folds in any backlog the batch cap did not reach, and
   * the two are different facts. `null` where the rule exempts nothing, which is
   * reported as zero rather than left unsaid.
   */
  heldBack: ((days: number) => SQL) | null;
}

/** Every table's statements, keyed by the physical table name a retention rule carries. */
export type RetentionStatements = Readonly<Record<string, TableStatements>>;
