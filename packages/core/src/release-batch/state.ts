import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { type BoundsReading, readBounds } from './bounds.js';
import { closeVerification, type ReleaseChannel, resolveReleaseChannels } from './channel.js';
import { ReleaseProbesUnreadableError } from './errors.js';
import { type ReleaseFinishRecord, readFinishRecord } from './finish-job.js';
import { type ReleaseStart, readReleaseStart } from './job-start.js';
import { listAttempts, type ReleaseAttemptRow } from './ledger.js';
import { type ReleaseMethod, readMethod } from './method.js';
import type { ReleaseVerification } from './plan.js';
import {
  loadReleaseRoster,
  loadRunIssues,
  type ReleaseRoster,
  type ReleaseRunIssue,
} from './queries.js';
import { type LiveState, readLiveState, type VerifyConfig } from './verify.js';

export interface ReleaseRunState {
  runId: string;
  projectId: string;
  runStatus: string;
  /** The version this release cut. `null` only on a release row nothing versioned. */
  version: string | null;
  /** The release gate now, not this run; the run's own roster is `runIssues`. */
  roster: ReleaseRoster;
  runIssues: ReleaseRunIssue[];
  attempts: ReleaseAttemptRow[];
  /** Read at request time from the probes the close reads; `null` where there are none to read. */
  live: LiveState | null;
  /**
   * How the close is proved, as the run recorded it: at the open, then again by the close itself,
   * so an open run's value is its opening forecast. `null` on a run that recorded none.
   */
  verification: ReleaseVerification | null;
  bounds: BoundsReading;
  /** `null` when the run never announced one. */
  method: ReleaseMethod | null;
  /** True when the agent announced that it could not load its method. */
  methodUnloaded: boolean;
  /** The last finish attempt, `null` before the first `finish` call. */
  finish: ReleaseFinishRecord | null;
  /** Whether a box has started this release's job, and if not, why not (ISS-1323). */
  start: ReleaseStart;
}

/** The probes the close reads, or none: a refused declaration has nothing to read either. */
function liveProbes(channels: ReleaseChannel[]): VerifyConfig | null {
  try {
    const verification = closeVerification(channels);
    return verification.kind === 'probed' ? verification.cfg : null;
  } catch (err) {
    if (err instanceof ReleaseProbesUnreadableError) return null;
    throw err;
  }
}

/** The run's own record of how its close is proved, stamped at create and again at the close. */
export function recordedVerification(
  meta: Record<string, unknown>,
  runId: string,
): ReleaseVerification | null {
  const value = meta.verification;
  if (value === undefined || value === null) return null;
  if (value === 'probed' || value === 'unverified') return value;
  throw new Error(
    `RELEASE_VERIFICATION_UNREADABLE: release run ${runId} records verification ${JSON.stringify(value)}, which is neither "probed" nor "unverified"`,
  );
}

async function readRun(runId: string) {
  const [run] = await db
    .select({
      projectId: pipelineRuns.projectId,
      status: pipelineRuns.status,
      metadata: pipelineRuns.metadata,
      releaseVersion: pipelineRuns.releaseVersion,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  return run;
}

/**
 * The whole of one release run, or `null` when the run is not one. The run row is read again
 * once the probes answer, so a probe that holds the call for its whole cap cannot hand back a
 * finish record or a run status from before it.
 */
export async function readReleaseRunState(runId: string): Promise<ReleaseRunState | null> {
  const first = await readRun(runId);
  if (!first) return null;
  if ((first.metadata as { source?: unknown } | null)?.source !== 'release-batch') return null;

  const channels = await resolveReleaseChannels(first.projectId);
  const verify = liveProbes(channels);
  const [roster, attempts, live] = await Promise.all([
    loadReleaseRoster(first.projectId),
    listAttempts(runId),
    verify ? readLiveState(verify) : Promise.resolve(null),
  ]);
  const run = (await readRun(runId)) ?? first;
  const [start, runIssues] = await Promise.all([
    readReleaseStart(runId, run.projectId, run.metadata),
    loadRunIssues(run.metadata),
  ]);
  const meta = (run.metadata ?? {}) as Record<string, unknown>;
  const method = readMethod(meta);

  return {
    runId,
    projectId: run.projectId,
    runStatus: run.status,
    version: run.releaseVersion,
    roster,
    runIssues,
    attempts,
    live,
    verification: recordedVerification(meta, runId),
    bounds: readBounds(attempts),
    method,
    methodUnloaded: method !== null && !method.loaded,
    finish: readFinishRecord(meta),
    start,
  };
}

/** The run is past a bound and a person should look before it does more. */
export class ReleaseRunHoldingError extends Error {
  constructor(public readonly crossed: string[]) {
    super('RELEASE_RUN_HOLDING');
    this.name = 'ReleaseRunHoldingError';
  }
}

/**
 * Refuse a further attempt on a run that is already past a bound.
 */
export async function assertRunNotHolding(runId: string): Promise<void> {
  const bounds = readBounds(await listAttempts(runId));
  if (bounds.holding) throw new ReleaseRunHoldingError(bounds.crossedNames);
}
