// The unattended cut: everything sitting at the release gate, on a cadence.
//
// A `release_batch` schedule needs no prompt, no script and no runner of its
// own — it claims what is waiting and enqueues the one batch job, which is the
// same thing a person pressing "Release now" does. Its whole job is to make the
// cut happen without someone remembering to.
//
// It skips rather than fails when nothing is waiting: an empty gate is the
// normal state of a healthy project, and a nightly cron that reports failure on
// a quiet night trains everyone to ignore it.

import { logger } from '../logger.js';
import { loadReleaseRoster } from '../release-batch/queries.js';
import {
  BatchInFlightError,
  ClaimConflictError,
  createReleaseBatch,
  NoReleaseGateError,
  NoRunnerOnlineError,
  ReleasePoolEmptyError,
} from '../release-batch/service.js';

export interface ScheduledCutOutcome {
  status: 'success' | 'skipped' | 'failed';
  output: string;
  error?: string;
}

export async function runScheduledReleaseCut(args: {
  projectId: string;
  userId: string;
}): Promise<ScheduledCutOutcome> {
  const roster = await loadReleaseRoster(args.projectId);
  if (!roster.gateStatus) {
    return { status: 'skipped', output: 'this project has no release gate' };
  }

  // cm:guard skip the already-claimed rows rather than failing on them: a batch in flight is a normal race with a person who pressed Release now, and the claim CAS would reject the whole cut over one issue.
  const waiting = roster.issues.filter((i) => i.claimedByRunId === null).map((i) => i.id);
  if (waiting.length === 0) {
    return { status: 'skipped', output: 'nothing is waiting at the release gate' };
  }

  try {
    const result = await createReleaseBatch({
      projectId: args.projectId,
      issueIds: waiting,
      userId: args.userId,
    });
    return {
      status: 'success',
      output: `cut ${result.issueIds.length} issue(s) as run ${result.runId}`,
    };
  } catch (err) {
    // cm:guard every one of these is "not now", never "broken" — a cron that reports failure for a batch already in flight, or for a release box offline at 04:00, is one people learn to ignore, and the next failure they ignore is a real one.
    if (
      err instanceof BatchInFlightError ||
      err instanceof ClaimConflictError ||
      err instanceof NoRunnerOnlineError ||
      err instanceof ReleasePoolEmptyError ||
      err instanceof NoReleaseGateError
    ) {
      return { status: 'skipped', output: `no cut this tick: ${(err as Error).message}` };
    }
    logger.error({ err, projectId: args.projectId }, 'schedule.release-batch: cut failed');
    return {
      status: 'failed',
      output: 'the scheduled cut failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
