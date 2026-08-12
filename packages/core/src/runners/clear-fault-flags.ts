// Operator-driven reset of every fault flag on one runner ("Clear error" in the
// project Runners screen).
//
// The automatic clears each own one cause: `clearRunnerLimit` fires on a
// successful job, the heartbeat expires a lapsed limit, quarantine self-heals on
// its TTL. None of them helps the operator who has just fixed the box by hand —
// the runner stays excluded from dispatch until it wins work it cannot be given.
// This is the manual override: forget the recorded fault and let dispatch try
// again. If the fault is still real the next failure re-stamps it within seconds,
// which is why the reset needs no confirmation of health.

import { and, eq, isNotNull, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runners } from '../db/schema.js';
import { logger } from '../logger.js';
import { broadcastRunnerChanged } from './apply-runner-limit.js';

// cm:guard every fault-flag column on `runners` must be listed here AND in the guard below — a column this reset forgets is one the operator cannot clear from the UI, which is how a box ends up permanently un-dispatchable
// cm:edge lockstep -> packages/core/src/runners/apply-runner-limit.ts — limit columns (limit_reason/rate_limited_until/limit_detail + the last_error mirror)
// cm:edge lockstep -> packages/core/src/runners/quarantine.ts — quarantine columns (quarantined_until/quarantine_reason)
export async function clearRunnerFaultFlags(runnerId: string, projectId: string): Promise<boolean> {
  const [cleared] = await db
    .update(runners)
    .set({
      lastError: null,
      limitReason: null,
      rateLimitedUntil: null,
      limitDetail: null,
      quarantinedUntil: null,
      quarantineReason: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(runners.id, runnerId),
        or(
          isNotNull(runners.lastError),
          isNotNull(runners.limitReason),
          isNotNull(runners.rateLimitedUntil),
          isNotNull(runners.limitDetail),
          isNotNull(runners.quarantinedUntil),
          isNotNull(runners.quarantineReason),
        ),
      ),
    )
    .returning({ id: runners.id });

  if (!cleared) return false;
  logger.info({ runnerId, projectId }, 'runner fault flags cleared by operator');
  broadcastRunnerChanged(projectId, runnerId);
  return true;
}
