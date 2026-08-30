/**
 * ISS-879 — clear the frozen-queue wedge once the pause is over.
 *
 * `alarmPausedRunsWithQueuedWork` stops matching the moment a run leaves
 * `paused`, and that alone would leave its notification unresolved forever: the
 * emitter's dedupe requires `resolvedAt IS NULL` AND an age under
 * `WEDGE_RENOTIFY_MS`, so a key nobody resolves stays in the owner's bell and
 * re-arms daily. `wedge.ts` says it outright — call this from whatever observes
 * the recovery, never on a timer.
 */

import { logger } from '../logger.js';
import type { HooksBus } from './hooks.js';
import { pausedRunWedgeEntityId, resolvePipelineWedge } from './wedge.js';

/**
 * Resolve on every `pipelineRunStatusChanged` that lands anywhere but `paused`.
 */
// cm:guard key off `toStatus`, NEVER `fromStatus` — `emitCloseHook` in pipeline/runs.ts hardcodes `fromStatus: 'running'` even on a paused→terminal close (it says so, and would need an extra round-trip not to), so a `fromStatus === 'paused'` test would silently miss every cancelled or completed run and resolve only the resumes.
// cm:edge lockstep -> packages/core/src/pipeline/run-pause.ts — `resumeRunsWhere` is the resume half of the recovery this listens for; both halves reach here through the same hook, which is why there is one subscriber and not a call at each write site
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
