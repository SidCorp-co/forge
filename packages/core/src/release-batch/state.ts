import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { type BoundsReading, readBounds } from './bounds.js';
import { closeVerification, type ReleaseChannel, resolveReleaseChannels } from './channel.js';
import { ReleaseProbesUnreadableError } from './errors.js';
import { type ReleaseFinishRecord, readFinishRecord } from './finish-job.js';
import { listAttempts, type ReleaseAttemptRow } from './ledger.js';
import { type ReleaseMethod, readMethod } from './method.js';
import { ownerBoxClause, readingOf, readOwnerCandidates } from './owner-boxes.js';
import { type ReleaseOwner, readOwner } from './owner-record.js';
import type { ReleaseVerification } from './plan.js';
import { loadReleaseRoster, type ReleaseRoster } from './queries.js';
import { type LiveState, readLiveState, type VerifyConfig } from './verify.js';

export interface ReleaseRunState {
  runId: string;
  projectId: string;
  runStatus: string;
  /** The version this release cut. `null` only on a release row nothing versioned. */
  version: string | null;
  roster: ReleaseRoster;
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
  /** Who owns the release, `null` on a batch cut before ISS-1281, which its job owned. */
  owner: ReleaseOwnerReading | null;
}

export interface ReleaseOwnerReading extends ReleaseOwner {
  /** While it waits: every box serving the project, with what stops it, read now. */
  boxes: Array<{ deviceName: string; able: boolean; clause: string; returnAt: string | null }>;
}

/** The owner record, and while it waits, why each box has not taken it. */
async function readOwnerNow(
  projectId: string,
  runId: string,
  meta: Record<string, unknown>,
): Promise<ReleaseOwnerReading | null> {
  const owner = readOwner(meta, runId);
  if (!owner) return null;
  if (owner.state !== 'awaiting') return { ...owner, boxes: [] };
  const label = (meta.releaseRunner as { label?: unknown } | undefined)?.label;
  const candidates = await readOwnerCandidates(projectId, typeof label === 'string' ? label : null);
  const able = new Set(candidates.eligible.map((b) => b.deviceId));
  return {
    ...owner,
    boxes: candidates.boxes.map((b) => ({
      deviceName: b.deviceName,
      able: able.has(b.deviceId),
      clause: ownerBoxClause(readingOf(b)),
      returnAt: b.returnAtMs === null ? null : new Date(b.returnAtMs).toISOString(),
    })),
  };
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
  const meta = (run.metadata ?? {}) as Record<string, unknown>;
  const method = readMethod(meta);

  return {
    runId,
    projectId: run.projectId,
    runStatus: run.status,
    version: run.releaseVersion,
    roster,
    attempts,
    live,
    verification: recordedVerification(meta, runId),
    bounds: readBounds(attempts),
    method,
    methodUnloaded: method !== null && !method.loaded,
    finish: readFinishRecord(meta),
    owner: await readOwnerNow(run.projectId, runId, meta),
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
