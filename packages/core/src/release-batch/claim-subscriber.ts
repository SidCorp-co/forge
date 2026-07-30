// ISS-764 — Layer 1 claim release: when a release_batch run terminates for any
// reason (completed / failed / cancelled), release every issue it claimed.
//
// Keying on the indexed `release_batch_run_id` column (not on run.metadata or
// run.kind) so the UPDATE touches only the exact batch's issues and can never
// steal a newer claim from a concurrent batch on the same project.
//
// Every death path already funnels through pipelineRunStatusChanged:
//   job done/failed/cancelled → closeRunIfOneShot (jobs/agent-session-link.ts)
//   operator cancelPipelineRun → runs-control.ts
//   reapOrphanedOneShotRuns → sweeper.ts
// A retried job leaves the run OPEN (retryPending) so the claim survives retry.

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { logger } from '../logger.js';
import type { HooksBus } from '../pipeline/hooks.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function registerReleaseBatchClaimSubscriber(bus: HooksBus): void {
  bus.on('pipelineRunStatusChanged', (p) => {
    if (!TERMINAL_STATUSES.has(p.toStatus)) return;

    void db
      .update(issues)
      .set({ releaseBatchRunId: null, updatedAt: sql`now()` })
      .where(eq(issues.releaseBatchRunId, p.runId))
      .returning({ id: issues.id })
      .then((released) => {
        if (released.length > 0) {
          logger.info(
            { runId: p.runId, count: released.length },
            'release-batch: claims released on run close',
          );
        }
      })
      .catch((err) => {
        logger.error({ err, runId: p.runId }, 'release-batch: claim release subscriber failed');
      });
  });
}
