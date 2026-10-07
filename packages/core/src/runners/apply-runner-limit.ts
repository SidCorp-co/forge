import { and, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runners } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { emitEvent } from '../outbox/index.js';
import { emitPipelineWedge, resolvePipelineWedge } from '../pipeline/index.js';
import type { RunnerLimit } from './limit-detect.js';

export async function broadcastRunnerChanged(projectId: string, runnerId: string): Promise<void> {
  await emitEvent(db, 'runner.changed', {
    projectId,
    runnerId,
    event: 'runner.status',
    data: { runnerId, projectId },
    runnerRoom: false,
  });
}

/**
 * Every binding of the device that owns `runnerId`, plus the row itself so a
 * device-less (remote) runner still resolves to exactly one row.
 */
function deviceScope(runnerId: string) {
  return sql`(
    ${runners.id} = ${runnerId}
    OR (
      ${runners.deviceId} IS NOT NULL
      AND ${runners.deviceId} = (SELECT device_id FROM runners WHERE id = ${runnerId})
    )
  )`;
}

/**
 * A binding's `lastError` that is the copy of its limit's detail, not an error it reported for itself.
 * Old values: inside an UPDATE this reads the row as it stood before the write (ISS-276: a limit stamped
 * through one binding and lifted through another left "resets Oct 8, 12am" on the first, with no limit).
 */
const lastErrorMirrorsLimit = sql`(${runners.lastError} = ${runners.limitDetail})`;

/**
 * Record a limit on every binding of the runner's device, and mirror its detail into `lastError` on
 * `runnerId` and on every binding still holding the previous limit's copy. No-ops when `runnerId` is
 * absent — orphan/sweeper failures may not carry a runner.
 */
export async function stampRunnerLimit(
  runnerId: string | null | undefined,
  projectId: string,
  limit: RunnerLimit,
): Promise<void> {
  if (!runnerId) return;
  try {
    const stamped = await db
      .update(runners)
      .set({
        limitReason: limit.reason,
        rateLimitedUntil: limit.nextTryAt,
        limitDetail: limit.detail,
        limitRefusedAt: limit.refusedAt,
        limitPrintedResetAt: limit.printedResetAt,
        lastError: sql`CASE WHEN ${runners.id} = ${runnerId} OR ${lastErrorMirrorsLimit} THEN ${limit.detail} ELSE ${runners.lastError} END`,
        updatedAt: new Date(),
      })
      .where(deviceScope(runnerId))
      .returning({ id: runners.id, projectId: runners.projectId });
    logger.info(
      {
        runnerId,
        bindings: stamped.length,
        reason: limit.reason,
        refusedAt: limit.refusedAt.toISOString(),
        nextTryAt: limit.nextTryAt?.toISOString() ?? null,
        printedResetAt: limit.printedResetAt?.toISOString() ?? null,
      },
      'runner limit stamped',
    );
    for (const row of stamped) await broadcastRunnerChanged(row.projectId, row.id);
    if (!stamped.some((r) => r.id === runnerId)) await broadcastRunnerChanged(projectId, runnerId);
    if (limit.reason === 'auth') await alarmAuthDeadRunner(runnerId, projectId, limit.detail);
  } catch (err) {
    logger.warn({ err, runnerId }, 'stampRunnerLimit failed, continuing');
  }
}

/**
 * Tell the project owner a box has gone auth-dead, because nothing else will.
 */
async function alarmAuthDeadRunner(
  runnerId: string,
  projectId: string,
  detail: string,
): Promise<void> {
  await emitPipelineWedge({
    projectId,
    hop: 'dispatch',
    entity: 'runner',
    entityId: runnerId,
    reason: `auth_dead:${detail}`,
    action:
      'Re-authenticate the agent CLI on that box, then clear the error on the runner so dispatch tries it again.',
    title: 'A runner can no longer authenticate, and will take no more work',
    summary:
      'This runner is excluded from dispatch until someone signs its agent CLI back in. Unlike a rate limit, an expired session has no reset time, so it will not come back on its own.',
    nextStep:
      'Sign in again on the box, then use "Clear error" on the Runners screen to put it back in rotation.',
  });
}

/**
 * Clear any limit on every binding of the runner's device, with the limit's copy in `lastError` on
 * whichever binding holds it, and the recorded `lastError` on the runner itself (called on successful
 * job completion — a box that just succeeded is not faulted). An error another binding reported for
 * itself stays. Cheap guard: only writes when one of them is actually set.
 */
export async function clearRunnerLimit(
  runnerId: string | null | undefined,
  projectId: string,
): Promise<void> {
  if (!runnerId) return;
  try {
    const cleared = await db
      .update(runners)
      .set({
        limitReason: null,
        rateLimitedUntil: null,
        limitDetail: null,
        limitRefusedAt: null,
        limitPrintedResetAt: null,
        lastError: sql`CASE WHEN ${runners.id} = ${runnerId} OR ${lastErrorMirrorsLimit} THEN NULL ELSE ${runners.lastError} END`,
        updatedAt: new Date(),
      })
      .where(
        and(
          deviceScope(runnerId),
          or(isNotNull(runners.limitReason), isNotNull(runners.lastError)),
        ),
      )
      .returning({ id: runners.id, projectId: runners.projectId });
    if (cleared.length > 0) {
      logger.info(
        { runnerId, projectId, bindings: cleared.length },
        'runner limit / lastError cleared',
      );
      for (const row of cleared) await broadcastRunnerChanged(row.projectId, row.id);
      await resolvePipelineWedge(runnerId);
    }
  } catch (err) {
    logger.warn({ err, runnerId }, 'clearRunnerLimit failed, continuing');
  }
}
