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
import { resolvePipelineWedge } from '../pipeline/wedge.js';
import { broadcastRunnerChanged } from './apply-runner-limit.js';

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
  await resolvePipelineWedge(runnerId);
  return true;
}
