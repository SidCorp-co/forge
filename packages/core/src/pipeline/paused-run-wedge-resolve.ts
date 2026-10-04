import { consume } from '../outbox/index.js';
import { pausedRunWedgeEntityId, resolvePipelineWedge } from './wedge.js';

/** Resolve the paused-run wedge on every run move that lands anywhere but `paused`. */
export function registerPausedRunWedgeResolve(): void {
  consume('run.transitioned', {
    name: 'paused-run-wedge-resolve',
    handle: async (p) => {
      if (p.to === 'paused') return;
      await resolvePipelineWedge(pausedRunWedgeEntityId(p.id));
    },
  });
}
