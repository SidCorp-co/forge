// ISS-1253: a release run parked on a person's gate outlives the job that brought it there. The
// job ends (its pane is concluded once its agent has ended its turn), and every close that ending
// would make, the one-shot close, the retry and the concluded-run sweep, reads the park first and
// leaves the run open: the person's decision carries it on, under the version it was cut with.

import { logger } from '../lib/logger.js';
import { releaseRunParked } from './ports.js';
import { closeRunIfOneShot } from './runs.js';
import type { RunFailureCause } from './runs-cascade.js';

/**
 * Close the one-shot run a job ended under, unless it is a release run parked on a person's gate.
 * Answers the park's sentence where the run was left open, null where the close was asked.
 */
export async function closeRunAfterJob(
  runId: string,
  outcome: 'completed' | 'failed' | 'cancelled',
  cause: RunFailureCause,
): Promise<string | null> {
  const parked = await releaseRunParked(runId);
  if (parked) {
    logger.info(
      { runId, outcome, parked },
      'pipeline: a job ended under a release run parked on a person; the run stays open for their decision',
    );
    return parked;
  }
  await closeRunIfOneShot(runId, outcome, cause);
  return null;
}

export { releaseRunParked };
