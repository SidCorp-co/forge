// Closing the phases an agent walked away from.
//
// `forge_phase` is declared by the agent, so a phase stays open until the
// agent says otherwise — and a session that finishes its work, closes the
// issue and exits has no reason left to go back and end its last phase. That
// row then reads exactly like a phase whose session died mid-way, and reports
// a NULL duration forever.
//
// The kernel does not trust the agent to clean up after itself anywhere else
// (see the orphan-hygiene table in CLAUDE.md); this is the same rule for the
// journal. The outcome is inferred from the job, and `source: 'system'` says
// so.

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

  // cm:guard both hooks, never only the happy one — a job that FAILS is exactly when a phase is most likely left open, and closing only on success leaves the crashed ones looking identical to the abandoned ones
  bus.on('jobCompleted', async (p) => close(p.jobId, 'ok'), { name: 'phase-journal-close' });
  bus.on('jobFailed', async (p) => close(p.jobId, 'failed'), { name: 'phase-journal-close' });
}
