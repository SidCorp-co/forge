import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications, projects } from '../db/schema.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { logger } from '../logger.js';
import { retryRescuesSince } from '../metrics/queries.js';
import { emitNotification } from '../notifications/emit.js';

export const RETRY_RESCUE_ALERT_THRESHOLD = 5;
export const RETRY_RESCUE_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RetryRescueAlertResult {
  detected: number;
  notified: number;
}

function windowStart(now: Date): Date {
  return new Date(
    Math.floor(now.getTime() / RETRY_RESCUE_ALERT_WINDOW_MS) * RETRY_RESCUE_ALERT_WINDOW_MS,
  );
}

export function retryRescueResolutionKey(projectId: string, reason: string, now: Date): string {
  return `retry-rescue:${projectId}:${encodeURIComponent(reason)}:${windowStart(now).toISOString()}`;
}

export async function detectRetryRescueThresholds(
  now: Date = new Date(),
): Promise<RetryRescueAlertResult> {
  try {
    const start = windowStart(now);
    const rows = await db.execute<{
      project_id: string;
      failure_reason: string;
      rescues: number | string;
    }>(sql`
      -- cm:guard the project list is NULL, meaning every project, and that is the one
      -- caller entitled to pass it: this runs on the sweeper across the whole
      -- deployment. An empty array here would be the opposite answer and would
      -- silence the alert entirely.
      SELECT project_id, failure_reason, count(*)::int AS rescues
      -- cm:guard the bound value is an ISO STRING with an explicit cast, never a \`Date\`.
      -- \`db.execute\` binds parameters through the driver rather than through drizzle's
      -- column encoders, and this driver refuses a \`Date\` outright:
      -- \`The "string" argument must be of type string\`. The throw lands inside this
      -- function's own catch, which logs and returns \`{ detected: 0, notified: 0 }\` — so the
      -- alarm has reported nothing since it was written and every tick looked healthy.
      -- Found by the integration case below it (ISS-1063); the same shape bit
      -- \`pipeline/reevaluate-conditions.ts\` and \`pipeline/issue-run-invariant.ts\`.
      FROM ${retryRescuesSince(null, sql`${start.toISOString()}::timestamptz`)}
      GROUP BY project_id, failure_reason
      HAVING count(*) >= ${RETRY_RESCUE_ALERT_THRESHOLD}
    `);

    let notified = 0;
    for (const row of rows) {
      const resolutionKey = retryRescueResolutionKey(row.project_id, row.failure_reason, now);
      const [existing] = await db
        .select({ id: notifications.id, resolvedAt: notifications.resolvedAt })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, 'retry_rescue_threshold'),
            eq(notifications.resolutionKey, resolutionKey),
          ),
        )
        .limit(1);
      // cm:guard ISS-1063 — an UNRESOLVED record is re-emitted on every pass, and the
      // delivery layer decides what that means. Two things need it. A `pending` record
      // (this type declares `pendingEvaluations: 2`) is promoted by a LATER emission of the
      // same identity, so short-circuiting on existence left the first pass writing a record
      // nobody would ever be told about and every later pass skipping it: an alarm that can
      // never fire, green on every tick. And a `firing` record whose delivery was held back
      // by a silence is delivered when that silence expires, which only happens if a later
      // pass reaches `recordAndDeliver` at all. `deliverTo` skips anybody already holding a
      // member link, so a re-emission tells nobody twice.
      // cm:guard a RESOLVED record still short-circuits: the key is scoped to the 24-hour
      // window, and emitting past a resolution would write a second record for the same
      // window rather than reopening the first.
      if (existing?.resolvedAt) continue;

      const [project] = await db
        .select({ createdBy: projects.createdBy })
        .from(projects)
        .where(eq(projects.id, row.project_id))
        .limit(1);
      if (!project) continue;

      const rescues = Number(row.rescues);
      try {
        // cm:guard `notified` counts people newly told, which is what the log line beside
        // it claims. Incrementing on the emission counted the first, pending, undelivered
        // sighting as a notification.
        const sent = await emitNotification({
          userId: project.createdBy,
          projectId: row.project_id,
          type: 'retry_rescue_threshold',
          title: `Retries rescued ${rescues} failures`,
          body: `“${row.failure_reason}” crossed the rescue threshold in this 24-hour window. The jobs eventually succeeded, but the repeated failure still needs attention.`,
          resolutionKey,
        });
        notified += sent?.delivered ?? 0;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }

    if (rows.length > 0) {
      logger.warn({ detected: rows.length, notified }, 'retry-rescues: threshold crossed');
    }
    return { detected: rows.length, notified };
  } catch (err) {
    logger.error({ err }, 'retry-rescues: threshold detection failed');
    return { detected: 0, notified: 0 };
  }
}
