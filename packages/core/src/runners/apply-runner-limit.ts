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

import { and, eq, isNotNull, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runners } from '../db/schema.js';
import { logger } from '../logger.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import type { RunnerLimit } from './limit-detect.js';

// cm:edge naming -> packages/core/src/runners/quarantine.ts — reused so runner.status has one broadcaster, not two competing writers
export function broadcastRunnerChanged(projectId: string, runnerId: string): void {
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
// cm:edge contract -> packages/core/src/jobs/dispatch-gates.ts — `fresh_capable_runners` matches the reason 'auth' as a LITERAL, so stamping it here is what hard-excludes the runner; renaming the enum member silently reopens dispatch to auth-dead boxes
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
 * Clear any limit AND any recorded `lastError` on the given runner (called on
 * successful job completion — a box that just succeeded is not faulted).
 * Cheap guard: only writes when one of them is actually set.
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
        // cm:why the mirrored limit text goes too, else the UI keeps rendering it as a generic "Last error" banner after recovery
        lastError: null,
        updatedAt: new Date(),
      })
      // cm:why the guard covers lastError as well: attributeFailureToRunner and the dispatcher's adapter-failure write set it WITHOUT a limitReason, so a limit-only guard left those boxes quoting a preflight error through every later success — dev1·cx read faulted 24min after its next job passed
      .where(
        and(
          eq(runners.id, runnerId),
          or(isNotNull(runners.limitReason), isNotNull(runners.lastError)),
        ),
      )
      .returning({ id: runners.id });
    if (cleared) {
      logger.info({ runnerId }, 'runner limit / lastError cleared');
      broadcastRunnerChanged(projectId, runnerId);
    }
  } catch (err) {
    logger.warn({ err, runnerId }, 'clearRunnerLimit failed, continuing');
  }
}
