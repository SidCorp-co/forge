// ISS-764 — Layer 1 claim release: when a release_batch run terminates for any
// reason (completed / failed / cancelled), release every issue it claimed and
// rescue any the batch left standing mid-release.
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

import { logger } from '../logger.js';
import type { HooksBus } from '../pipeline/hooks.js';
import { recoverStrandedReleasing } from './releasing-recovery.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function registerReleaseBatchClaimSubscriber(bus: HooksBus): void {
  bus.on('pipelineRunStatusChanged', (p) => {
    if (!TERMINAL_STATUSES.has(p.toStatus)) return;

    // cm:guard route the clear through `recoverStrandedReleasing` and never UPDATE the column here: `finish` and `abort` take their issues off `releasing` BEFORE the run goes terminal, so anything this pass still finds there got no outcome at all — and a bare clear leaves it at `releasing` with the run id gone, which is a status no machine can then exit.
    void recoverStrandedReleasing(p.runId, {
      reason: `The release batch run ended ${p.toStatus} without finishing or aborting`,
    })
      .then(({ released, recovered }) => {
        if (released.length > 0) {
          logger.info(
            { runId: p.runId, count: released.length, recovered: recovered.length },
            'release-batch: claims released on run close',
          );
        }
      })
      .catch((err) => {
        logger.error({ err, runId: p.runId }, 'release-batch: claim release subscriber failed');
      });
  });
}
