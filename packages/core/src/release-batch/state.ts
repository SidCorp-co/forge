/**
 * Everything about a release run, assembled from the world rather than from a
 * session's memory.
 *
 * A release run's whole state lived in the transcript of whichever box was
 * running it. Kill that session and the next agent — on the same box or another
 * one — had the roster and nothing else: not what had already been promoted,
 * not what had been deployed, not what the probes said last time, and no way to
 * tell a release that had done nothing from one that had deployed three times.
 *
 * So this read takes the four things a continuation needs and takes each from
 * the place that owns it: the roster from `issues`, the ledger from
 * `release_attempts`, the health and identity of production from the probes NOW
 * rather than from any record, and the bounds from the ledger's own clock.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { type BoundsReading, readBounds } from './bounds.js';
import { resolveReleaseChannels } from './channel.js';
import { listAttempts, type ReleaseAttemptRow } from './ledger.js';
import { type ReleaseMethod, readMethod } from './method.js';
import { loadReleaseRoster, type ReleaseRoster } from './queries.js';
import { type LiveState, readLiveState } from './verify.js';

export interface ReleaseRunState {
  runId: string;
  projectId: string;
  runStatus: string;
  roster: ReleaseRoster;
  attempts: ReleaseAttemptRow[];
  /** Read at request time. `null` only when the project declares no probes. */
  live: LiveState | null;
  bounds: BoundsReading;
  /** `null` when the run never announced one — which `finish` refuses. */
  method: ReleaseMethod | null;
  /** True when the agent announced that it could not load its method. */
  methodUnloaded: boolean;
}

/**
 * The whole of one release run, or `null` when the run is not one.
 */
// cm:guard the live reading is taken HERE, on every call, and is never served from `release_attempts`. The ledger says what production looked like at each attempt; this question is what it looks like now, and answering it from the newest row would hand a resuming agent a reading from before the outage it was woken up for.
// cm:guard `live` is `null` ONLY for a project that declares no probes, and that is a state `createReleaseBatch` now refuses to create. It is kept representable because a run cut before that refusal reaches this read, and collapsing it into a `down` reading would report an outage over a project that never told anyone where to look.
export async function readReleaseRunState(runId: string): Promise<ReleaseRunState | null> {
  const [run] = await db
    .select({
      id: pipelineRuns.id,
      projectId: pipelineRuns.projectId,
      status: pipelineRuns.status,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!run) return null;
  const meta = (run.metadata ?? {}) as Record<string, unknown>;
  if (meta.source !== 'release-batch') return null;

  const channels = await resolveReleaseChannels(run.projectId);
  const verify = channels[0]?.verify ?? null;
  const [roster, attempts, live] = await Promise.all([
    loadReleaseRoster(run.projectId),
    listAttempts(runId),
    verify ? readLiveState(verify) : Promise.resolve(null),
  ]);
  const method = readMethod(meta);

  return {
    runId,
    projectId: run.projectId,
    runStatus: run.status,
    roster,
    attempts,
    live,
    bounds: readBounds(attempts),
    method,
    methodUnloaded: method !== null && !method.loaded,
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
// cm:guard the bounds are re-read from the LEDGER here and not taken from a cached state: a run crosses a bound by time passing, so a verdict computed at the last request would let a run that went quiet an hour ago record one more attempt because nothing had asked since.
// cm:guard this refuses the ATTEMPT and never the account. An agent that is already mid-act must still be able to say what happened — refusing that would make a holding run's last act the one nothing is recorded about, which is the act worth reading.
export async function assertRunNotHolding(runId: string): Promise<void> {
  const bounds = readBounds(await listAttempts(runId));
  if (bounds.holding) throw new ReleaseRunHoldingError(bounds.crossedNames);
}
