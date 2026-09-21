import { logger } from '../logger.js';
import type { HooksBus } from './hooks.js';
import { closeDanglingPhasesForJob } from './phase-journal.js';

/** Register the dangling-phase closer. Called once at boot from `src/index.ts`. */
export function registerPhaseJournalClose(bus: HooksBus): void {
  const close = async (jobId: string, outcome: 'ok' | 'failed') => {
    try {
      const n = await closeDanglingPhasesForJob(jobId, outcome);
      if (n > 0) {
        logger.info(
          { jobId, outcome, closed: n },
          'phase-journal: closed phases the job left open',
        );
      }
    } catch (err) {
      logger.error({ err, jobId }, 'phase-journal: dangling close failed');
    }
  };

  bus.on('jobCompleted', async (p) => close(p.jobId, 'ok'), { name: 'phase-journal-close' });
  bus.on('jobFailed', async (p) => close(p.jobId, 'failed'), { name: 'phase-journal-close' });
}
