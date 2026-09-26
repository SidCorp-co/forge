// The unattended cut: everything sitting at the release gate, on a cadence.
//
// A `release_batch` schedule needs no prompt, no script and no runner of its own — it
// claims what is waiting and enqueues the one batch job, which is the same thing a
// person pressing "Release now" does, without someone remembering to.
//
// It skips rather than fails when nothing is waiting: an empty gate is the
// normal state of a healthy project, and a nightly cron that reports failure on
// a quiet night trains everyone to ignore it.

import { logger } from '../logger.js';
import { blockersOf, RELEASE_ROSTER_LIMIT } from '../release-batch/blocker-sentences.js';
import { loadReleaseRoster } from '../release-batch/queries.js';
import {
  BatchInFlightError,
  ClaimConflictError,
  createReleaseBatch,
  NoReleaseGateError,
  NoRunnerOnlineError,
  ReleasePoolEmptyError,
  ReleaseRecordMissingError,
} from '../release-batch/service.js';

export interface ScheduledCutOutcome {
  status: 'success' | 'skipped' | 'failed';
  output: string;
  error?: string;
  /** The issues this attempt named — at most one release's worth of what it was handed. */
  named: string[];
  /** The refusal's code, on a `skipped` cut that a named refusal stopped. */
  code?: string;
  /** Every reason standing when the cut was refused or failed, the thrown one first. */
  reasons?: string[];
}

// Carrying a readiness blocker makes an error a refusal; these classes name one thrown without.
const CLASSIFIED_REFUSALS: ReadonlyArray<readonly [new (...args: never[]) => Error, string]> = [
  [BatchInFlightError, 'BATCH_IN_FLIGHT'],
  [ClaimConflictError, 'CLAIM_CONFLICT'],
  [NoRunnerOnlineError, 'NO_RUNNER_ONLINE'],
  [ReleasePoolEmptyError, 'RELEASE_POOL_EMPTY'],
  [NoReleaseGateError, 'NO_RELEASE_GATE'],
  [ReleaseRecordMissingError, 'RELEASE_RECORD_MISSING'],
];

function reasonsOf(err: unknown): string[] {
  const carried = blockersOf(err).map((b) => b.message);
  if (carried.length > 0) return carried;
  return [err instanceof Error ? err.message : String(err)];
}

// One classified `createReleaseBatch` attempt, shared with ISS-1117's sweep pass.
export async function cutWaitingRelease(args: {
  projectId: string;
  userId: string;
  issueIds: string[];
}): Promise<ScheduledCutOutcome> {
  if (args.issueIds.length === 0) {
    return { status: 'skipped', output: 'nothing is waiting at the release gate', named: [] };
  }

  const named = args.issueIds.slice(0, RELEASE_ROSTER_LIMIT);
  try {
    const result = await createReleaseBatch({
      projectId: args.projectId,
      issueIds: named,
      userId: args.userId,
    });
    return {
      status: 'success',
      output: `cut ${result.issueIds.length} issue(s) as run ${result.runId}`,
      named,
    };
  } catch (err) {
    const code =
      blockersOf(err)[0]?.code ?? CLASSIFIED_REFUSALS.find(([cls]) => err instanceof cls)?.[1];
    if (code) {
      return {
        status: 'skipped',
        output: `no cut this tick: ${err instanceof Error ? err.message : String(err)}`,
        named,
        code,
        reasons: reasonsOf(err),
      };
    }
    logger.error({ err, projectId: args.projectId }, 'schedule.release-batch: cut failed');
    return {
      status: 'failed',
      output: 'the scheduled cut failed',
      error: err instanceof Error ? err.message : String(err),
      named,
      reasons: reasonsOf(err),
    };
  }
}

export async function runScheduledReleaseCut(args: {
  projectId: string;
  userId: string;
}): Promise<ScheduledCutOutcome> {
  const roster = await loadReleaseRoster(args.projectId);
  if (!roster.gateStatus) {
    return { status: 'skipped', output: 'this project has no release gate', named: [] };
  }

  const waiting = roster.issues.filter((i) => i.claimedByRunId === null).map((i) => i.id);
  return cutWaitingRelease({ projectId: args.projectId, userId: args.userId, issueIds: waiting });
}
