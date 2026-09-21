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
