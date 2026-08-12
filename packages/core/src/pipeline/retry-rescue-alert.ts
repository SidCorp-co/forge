import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications, projects } from '../db/schema.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { logger } from '../logger.js';
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
      SELECT project_id, failure_reason, count(*)::int AS rescues
      FROM retry_rescues
      WHERE rescued_at >= ${start}
      GROUP BY project_id, failure_reason
      HAVING count(*) >= ${RETRY_RESCUE_ALERT_THRESHOLD}
    `);

    let notified = 0;
    for (const row of rows) {
      const resolutionKey = retryRescueResolutionKey(row.project_id, row.failure_reason, now);
      const [existing] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, 'retry_rescue_threshold'),
            eq(notifications.resolutionKey, resolutionKey),
          ),
        )
        .limit(1);
      if (existing) continue;

      const [project] = await db
        .select({ createdBy: projects.createdBy })
        .from(projects)
        .where(eq(projects.id, row.project_id))
        .limit(1);
      if (!project) continue;

      const rescues = Number(row.rescues);
      try {
        await emitNotification({
          userId: project.createdBy,
          projectId: row.project_id,
          type: 'retry_rescue_threshold',
          title: `Retries rescued ${rescues} failures`,
          body: `“${row.failure_reason}” crossed the rescue threshold in this 24-hour window. The jobs eventually succeeded, but the repeated failure still needs attention.`,
          resolutionKey,
        });
        notified++;
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
