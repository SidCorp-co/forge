import { lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reportExecutions } from '../db/schema-report-executions.js';
import { reportRuns } from '../db/schema-report-runs.js';

/** Deletes every run past its keep; the nightly retention pass calls it. A read past the keep is refused before the sweep reaches the row. */
export async function sweepExpiredReportRuns(
  now: Date = new Date(),
): Promise<{ reportRuns: number }> {
  const gone = await db
    .delete(reportRuns)
    .where(lte(reportRuns.expiresAt, now))
    .returning({ id: reportRuns.id });
  return { reportRuns: gone.length };
}

/** Deletes every execution past its 30-day keep, as runs are; a read past it is refused by name first. */
export async function sweepExpiredExecutions(
  now: Date = new Date(),
): Promise<{ reportExecutions: number }> {
  const gone = await db
    .delete(reportExecutions)
    .where(lte(reportExecutions.expiresAt, now))
    .returning({ id: reportExecutions.id });
  return { reportExecutions: gone.length };
}
