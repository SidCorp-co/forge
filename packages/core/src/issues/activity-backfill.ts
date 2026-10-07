import { sql } from 'drizzle-orm';
import { backfillMarkedIn, markBackfillIn } from '../db/backfill-markers.js';
import { type Db, db } from '../db/client.js';

/** The `backfill_markers` key set once no `issue.updated` row holds the pre-0344 snapshot shape. */
export const ACTIVITY_FIELD_CHANGES_KEY = 'activity-field-changes';

export interface ActivityBackfillReport {
  /** Issues whose chain this run converted. */
  chains: number;
  /** `issue.updated` rows those chains held. */
  rows: number;
  /** Issues whose chain was refused, each named; the marker stays unset while any is. */
  refusals: Array<{ issueId: string; reason: string }>;
}

export type Executor = Pick<Db, 'execute' | 'transaction'>;

/**
 * Convert every `issue.updated` row still holding `{fields, before, after}` into the changes it
 * made (migration 0344's `forge_issue_update_convert`), one issue's chain per transaction because
 * the anchor rule reads the whole chain. A killed run keeps the chains it committed and the next
 * boot lists only what is left. The marker is recorded when a run leaves no chain refused, so a
 * database with nothing to convert records it at once. Returns null when it already was.
 */
export async function runActivityFieldChangesBackfillOnce(
  conn: Executor = db,
): Promise<ActivityBackfillReport | null> {
  const marked = await conn.transaction((tx) => backfillMarkedIn(tx, ACTIVITY_FIELD_CHANGES_KEY));
  if (marked) return null;

  const pending = (await conn.execute(
    sql`SELECT DISTINCT issue_id FROM activity_log
        WHERE action = 'issue.updated' AND NOT payload ? 'changes'
        ORDER BY issue_id`,
  )) as unknown as Array<{ issue_id: string }>;

  const report: ActivityBackfillReport = { chains: 0, rows: 0, refusals: [] };
  for (const { issue_id: issueId } of pending) {
    try {
      const rows = await conn.transaction(async (tx) => {
        const out = (await tx.execute(
          sql`SELECT forge_issue_update_convert(${issueId}::uuid) AS n`,
        )) as unknown as Array<{ n: number }>;
        return out[0]?.n ?? 0;
      });
      report.chains += 1;
      report.rows += rows;
    } catch (err) {
      report.refusals.push({
        issueId,
        reason: refusalOf(err),
      });
    }
  }

  if (report.refusals.length === 0) {
    await conn.transaction((tx) => markBackfillIn(tx, ACTIVITY_FIELD_CHANGES_KEY));
  }
  return report;
}

/** The database's own message, which drizzle carries on `cause` under its "Failed query" wrapper. */
function refusalOf(err: unknown): string {
  if (err instanceof Error && err.cause instanceof Error) return err.cause.message;
  return err instanceof Error ? err.message : String(err);
}
