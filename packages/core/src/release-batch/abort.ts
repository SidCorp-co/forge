// abort: cancels the run and every job under it and closes no issue. A run ends `cancelled` here and
// `completed` on a finish, which is what stops `getActiveReleaseBatch` answering a batch whose work
// is over.

import type { PipelineRunStatus } from '../db/schema.js';
import { cancelConcludedRun, closeRunIfOneShot } from '../pipeline/index.js';
import { closedBeforeAbort, settleAbortStamp, stampAbort } from './abort-stamp.js';
import {
  type RecoverStrandedReleasingResult,
  recoverStrandedReleasing,
} from './releasing-recovery.js';

/** What the recovery did to the roster, and what the abort did to the run row. `alreadyClosed` is
 *  every roster issue closed when the abort ran, claimed or not (`closedBeforeAbort`). */
interface AbortReleaseBatchResult extends RecoverStrandedReleasingResult {
  run: {
    status: PipelineRunStatus | null;
    wasAlreadyTerminal: boolean;
    cancelledFrom: PipelineRunStatus | null;
  };
}

/**
 * What an abort does with a roster whose run already promoted.
 *
 * `hold` is the default: the code is on production, and the roster stays held at
 * `awaiting_release` at its `release` step. `return-to-gate` is the operator's route to terminal for
 * a batch that promoted and cannot verify, putting the roster back where
 * `POST /release-records` closes it against what production serves, with an
 * account (ISS-1199).
 */
type PromotedRosterSettlement = 'hold' | 'return-to-gate';

interface AbortReleaseBatchOptions {
  promotedRoster?: PromotedRosterSettlement | undefined;
}

export async function abortReleaseBatch(
  runId: string,
  reason: string,
  actorUserId: string,
  options: AbortReleaseBatchOptions = {},
): Promise<AbortReleaseBatchResult> {
  // First, so a finish sees the abort before the recovery and the cancel below (abort-stamp.ts).
  const stampId = await stampAbort(runId, {
    reason,
    by: actorUserId,
    holdPromotedRoster: options.promotedRoster !== 'return-to-gate',
  });
  const recovery = await recoverStrandedReleasing(runId, {
    reason: `batch release aborted: ${reason}`,
    actorUserId,
    comment: true,
    settlePromotedRoster: options.promotedRoster === 'return-to-gate',
  });
  const held = recovery.promoted && options.promotedRoster !== 'return-to-gate';
  const roster = held ? 'held' : 'released';
  const alreadyClosed = await closedBeforeAbort(runId, recovery.alreadyClosed);
  await settleAbortStamp(runId, stampId, { roster, closed: alreadyClosed });

  await closeRunIfOneShot(runId, 'cancelled');

  const after = await cancelConcludedRun(runId);

  return {
    ...recovery,
    alreadyClosed,
    run: {
      status: after.cancelled ? 'cancelled' : after.was,
      wasAlreadyTerminal: after.cancelled,
      cancelledFrom: after.cancelled ? after.was : null,
    },
  };
}
