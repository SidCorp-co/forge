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
  /** The version this release cut. `null` only on a release row nothing versioned. */
  version: string | null;
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
export async function readReleaseRunState(runId: string): Promise<ReleaseRunState | null> {
  const [run] = await db
    .select({
      id: pipelineRuns.id,
      projectId: pipelineRuns.projectId,
      status: pipelineRuns.status,
      metadata: pipelineRuns.metadata,
      releaseVersion: pipelineRuns.releaseVersion,
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
    version: run.releaseVersion,
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
export async function assertRunNotHolding(runId: string): Promise<void> {
  const bounds = readBounds(await listAttempts(runId));
  if (bounds.holding) throw new ReleaseRunHoldingError(bounds.crossedNames);
}
