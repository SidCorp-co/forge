/**
 * Write side of runner rate-limit / usage-limit / auth highlighting.
 *
 * `stampRunnerLimit` is called from the failure-finalize tail when a job fails
 * with a limit-class error; it records WHY the owning runner is limited and
 * (for time-based limits) until WHEN. `clearRunnerLimit` is called when a job
 * completes successfully, so a runner that recovers stops showing the badge
 * even before its parsed reset time elapses.
 *
 * The dispatcher treats a runner with `rateLimitedUntil` in the future as
 * unavailable, and excludes an `auth` limit by NAME — auth has no reset time,
 * so the time predicate alone reads an auth-dead runner as healthy. An auth
 * stamp is therefore not cosmetic and not self-healing: it hard-excludes the
 * runner from dispatch until an operator clears it, because `clearRunnerLimit`
 * below fires on a successful job the runner can no longer be given.
 *
 * Both helpers reuse the existing `runner.status` project-room broadcast (the
 * same event the heartbeat emits) so the web-v2 runners view refreshes live.
 */

import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runners } from '../db/schema.js';
import { logger } from '../logger.js';
import { emitPipelineWedge, resolvePipelineWedge } from '../pipeline/wedge.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import type { RunnerLimit } from './limit-detect.js';

export function broadcastRunnerChanged(projectId: string, runnerId: string): void {
  roomManager.publish(projectRoom(projectId), {
    event: 'runner.status',
    // projectId lets the web event-router refresh the project's runner list
    // (dashboard card + Runners screen), not just the runner activity feed.
    data: { runnerId, projectId },
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
 * Record a limit on every binding of the runner's device. No-ops when
 * `runnerId` is absent — orphan/sweeper failures may not carry a runner.
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
        rateLimitedUntil: limit.until,
        limitDetail: limit.detail,
        updatedAt: new Date(),
      })
      .where(deviceScope(runnerId))
      .returning({ id: runners.id, projectId: runners.projectId });
    await db
      .update(runners)
      .set({ lastError: limit.detail, updatedAt: new Date() })
      .where(eq(runners.id, runnerId));
    logger.info(
      {
        runnerId,
        bindings: stamped.length,
        reason: limit.reason,
        until: limit.until?.toISOString() ?? null,
      },
      'runner limit stamped',
    );
    for (const row of stamped) broadcastRunnerChanged(row.projectId, row.id);
    if (!stamped.some((r) => r.id === runnerId)) broadcastRunnerChanged(projectId, runnerId);
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
 * Clear any limit on every binding of the runner's device, and the recorded
 * `lastError` on the runner itself (called on successful job completion — a box
 * that just succeeded is not faulted). Cheap guard: only writes when one of
 * them is actually set.
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
        lastError: sql`CASE WHEN ${runners.id} = ${runnerId} THEN NULL ELSE ${runners.lastError} END`,
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
      for (const row of cleared) broadcastRunnerChanged(row.projectId, row.id);
      await resolvePipelineWedge(runnerId);
    }
  } catch (err) {
    logger.warn({ err, runnerId }, 'clearRunnerLimit failed, continuing');
  }
}
