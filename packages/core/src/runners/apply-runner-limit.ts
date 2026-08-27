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
import { emitPipelineWedge, resolvePipelineWedge } from '../pipeline/wedge.js';
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
    if (limit.reason === 'auth') await alarmAuthDeadRunner(runnerId, projectId, limit.detail);
  } catch (err) {
    logger.warn({ err, runnerId }, 'stampRunnerLimit failed, continuing');
  }
}

/**
 * Tell the project owner a box has gone auth-dead, because nothing else will.
 */
// cm:guard ONLY `auth` alarms here. A rate or usage limit carries a reset time and lifts itself, so alarming on one is noise the operator learns to ignore; `auth` has `until: null` BY DESIGN, is excluded from dispatch by name, and `clearRunnerLimit` can only fire on a job the runner will never be given — so it is the one limit that sits at online-and-idle until a human acts, which is exactly the state ISS-862 asked to be told about. Device dev1-ai013 held it for 5.5h across 421 jobs and nothing anywhere said so.
// cm:edge naming -> packages/core/src/runners/quarantine.ts — both alarms key the wedge on the RUNNER id (`wedge:<runnerId>`), and `emitPipelineWedge` returns early on an unresolved notification with that key inside WEDGE_RENOTIFY_MS, so whichever fault lands first is the only one the operator is told about for a day. That is deliberate, and it is only sound because BOTH faults exclude the box from dispatch — an auth stamp by name, a quarantine by `quarantinedUntil` — so the second fault cannot accumulate while the first stands, and clearing the first resolves the wedge, which is what lets the next real fault alarm. Break either exclusion and this becomes a silenced alarm: `resolvePipelineWedge(runnerId)` must therefore be called from EVERY clear on this row.
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
      // cm:guard a job succeeded on this box, so whatever wedge its fault raised is over — resolve it here as well as in `clearRunnerQuarantine`, because the auth alarm is raised from this file and the wedge re-notifies at most daily: leave it standing and the operator both keeps a dead alarm and misses the next real one the same day
      await resolvePipelineWedge(runnerId);
    }
  } catch (err) {
    logger.warn({ err, runnerId }, 'clearRunnerLimit failed, continuing');
  }
}
