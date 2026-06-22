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
 * unavailable; an `auth` limit (no reset time) is highlighted for the operator
 * but does not itself gate dispatch — the underlying 401 keeps failing jobs,
 * and the circuit breaker trips the device after the configured streak.
 *
 * Both helpers reuse the existing `runner.status` project-room broadcast (the
 * same event the heartbeat emits) so the web-v2 runners view refreshes live.
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runners } from '../db/schema.js';
import { logger } from '../logger.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import type { RunnerLimit } from './limit-detect.js';

function broadcastRunnerChanged(projectId: string, runnerId: string): void {
  roomManager.publish(projectRoom(projectId), {
    event: 'runner.status',
    // projectId lets the web event-router refresh the project's runner list
    // (dashboard card + Runners screen), not just the runner activity feed.
    data: { runnerId, projectId },
  });
}

/**
 * Record a limit on the given runner. No-ops when `runnerId` is absent —
 * orphan/sweeper failures may not carry a runner.
 */
export async function stampRunnerLimit(
  runnerId: string | null | undefined,
  projectId: string,
  limit: RunnerLimit,
): Promise<void> {
  if (!runnerId) return;
  try {
    await db
      .update(runners)
      .set({
        limitReason: limit.reason,
        rateLimitedUntil: limit.until,
        limitDetail: limit.detail,
        // Mirror into lastError so existing surfaces still show context.
        lastError: limit.detail,
        updatedAt: new Date(),
      })
      .where(eq(runners.id, runnerId));
    logger.info(
      {
        runnerId,
        reason: limit.reason,
        until: limit.until?.toISOString() ?? null,
      },
      'runner limit stamped',
    );
    broadcastRunnerChanged(projectId, runnerId);
  } catch (err) {
    logger.warn({ err, runnerId }, 'stampRunnerLimit failed, continuing');
  }
}

/**
 * Clear any limit on the given runner (called on successful job completion).
 * Cheap guard: only writes when a limit is actually set.
 */
export async function clearRunnerLimit(
  runnerId: string | null | undefined,
  projectId: string,
): Promise<void> {
  if (!runnerId) return;
  try {
    const [cleared] = await db
      .update(runners)
      .set({
        limitReason: null,
        rateLimitedUntil: null,
        limitDetail: null,
        // Also clear the mirrored lastError, else the UI falls back to showing
        // the stale limit text as a generic "Last error" banner after recovery.
        lastError: null,
        updatedAt: new Date(),
      })
      .where(and(eq(runners.id, runnerId), isNotNull(runners.limitReason)))
      .returning({ id: runners.id });
    if (cleared) {
      logger.info({ runnerId }, 'runner limit cleared');
      broadcastRunnerChanged(projectId, runnerId);
    }
  } catch (err) {
    logger.warn({ err, runnerId }, 'clearRunnerLimit failed, continuing');
  }
}
