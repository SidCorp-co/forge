/**
 * ISS-879 — clear the frozen-queue wedge once the pause is over.
 *
 * `alarmPausedRunsWithQueuedWork` stops matching the moment a run leaves
 * `paused`, and that alone would leave its notification unresolved forever: the
 * emitter's dedupe requires `resolvedAt IS NULL` AND an age under
 * `WEDGE_RENOTIFY_MS`, so a key nobody resolves stays in the owner's bell and
 * re-arms daily.
 *
 * This is the run half. The queue half — an operator cancelling the steps and
 * leaving the pause standing — is resolved by `alarmPausedRunsWithQueuedWork`
 * itself, which re-derives the condition each sweep; neither is a blind timer.
 */

import { logger } from '../logger.js';
import type { HooksBus } from './hooks.js';
import { pausedRunWedgeEntityId, resolvePipelineWedge } from './wedge.js';

/**
 * Resolve on every `pipelineRunStatusChanged` that lands anywhere but `paused`.
 */
export function registerPausedRunWedgeResolve(bus: HooksBus): void {
  bus.on('pipelineRunStatusChanged', async (payload) => {
    if (payload.toStatus === 'paused') return;
    try {
      await resolvePipelineWedge(pausedRunWedgeEntityId(payload.runId));
    } catch (err) {
      logger.warn(
        { err, runId: payload.runId, toStatus: payload.toStatus },
        'paused-run-wedge-resolve: resolve failed',
      );
    }
  });
}
