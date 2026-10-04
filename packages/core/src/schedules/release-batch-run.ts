// The unattended cut: everything sitting at the release gate, on a cadence.
//
// A `release_batch` schedule needs no prompt, no script and no runner of its own — it
// claims what is waiting and enqueues the one batch job, which is the same thing a
// person pressing "Release now" does, without someone remembering to.
//
// It skips rather than fails when nothing is waiting: an empty gate is the
// normal state of a healthy project, and a nightly cron that reports failure on
// a quiet night trains everyone to ignore it.

import { RELEASE_BLOCKER_CODES, RELEASE_ROSTER_LIMIT } from '@forge/contracts/releases';
import { counted } from '../lib/plural.js';
import { RefusalError } from '../lib/refusal.js';
import { logger } from '../observability/logger.js';
import { schedulesPorts } from './ports.js';

interface ScheduledCutOutcome {
  status: 'success' | 'skipped' | 'failed';
  output: string;
  error?: string;
  /** The issues this attempt named — at most one release's worth of what it was handed. */
  named: string[];
  /** The refusal's code, on a `skipped` cut that a named refusal stopped. */
  code?: string;
  /** Every reason standing when the cut was refused or failed, the thrown one first. */
  reasons?: string[];
  /** The release run a `success` cut started. */
  runId?: string;
}

const BLOCKERS: ReadonlySet<string> = new Set(RELEASE_BLOCKER_CODES);

/** A refusal led by a release blocker skips the tick; any other failure fails it. */
function blockerCodeOf(err: unknown): string | null {
  const head = err instanceof RefusalError ? err.refusals[0]?.code : undefined;
  return head && BLOCKERS.has(head) ? head : null;
}

function reasonsOf(err: unknown): string[] {
  if (err instanceof RefusalError) return err.refusals.map((r) => r.detail);
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
    const cut = (issueIds: string[]) =>
      schedulesPorts().createReleaseBatch({
        projectId: args.projectId,
        issueIds,
        userId: args.userId,
      });
    const result = await cut(named);
    return {
      status: 'success',
      output: `cut ${counted(result.issueIds.length, 'issue')} as run ${result.runId}`,
      named,
      runId: result.runId,
    };
  } catch (err) {
    const code = blockerCodeOf(err);
    if (code) {
      return {
        status: 'skipped',
        output: `no cut this tick: ${reasonsOf(err)[0] ?? code}`,
        named,
        code,
        reasons: reasonsOf(err),
      };
    }
    logger.error({ err, projectId: args.projectId }, 'schedule.release-batch: cut failed');
    return {
      status: 'failed',
      output: 'the scheduled cut failed',
      error: reasonsOf(err).join(' '),
      named,
      reasons: reasonsOf(err),
    };
  }
}

export async function runScheduledReleaseCut(args: {
  projectId: string;
  userId: string;
}): Promise<ScheduledCutOutcome> {
  const roster = await schedulesPorts().loadReleaseRoster(args.projectId);
  if (!roster.gateStatus) {
    return {
      status: 'skipped',
      output: 'this project has no release gate',
      named: [],
      code: 'NO_RELEASE_GATE',
    };
  }

  const waiting = roster.issues.filter((i) => i.claimedByRunId === null).map((i) => i.id);
  return cutWaitingRelease({ projectId: args.projectId, userId: args.userId, issueIds: waiting });
}
