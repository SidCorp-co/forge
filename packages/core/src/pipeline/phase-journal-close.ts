import { logger } from '../observability/logger.js';
import { consume } from '../outbox/index.js';
import { closeDanglingPhasesForJob } from './phase-journal.js';

/** Register the dangling-phase closer. Called once at boot from `src/index.ts`. */
export function registerPhaseJournalClose(): void {
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

  consume('job.transitioned', {
    name: 'phase-journal-close',
    handle: (p) => close(p.id, p.to === 'done' ? 'ok' : 'failed'),
  });
}
