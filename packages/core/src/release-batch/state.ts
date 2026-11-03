import type { ProbeReplayRecord } from '@forge/contracts/criterion-probes';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import type { ReleaseAttemptRow } from '../db/schema-release-ledger.js';
import { type RunFailure, readRunFailure } from '../pipeline/index.js';
import { type ReleaseChannel, resolveReleaseChannels } from './channel.js';
import { type ReleaseFinishRecord, readFinishRecord } from './finish-job.js';
import { type ReleaseMethod, readMethod } from './method.js';
import { RECORDED_VERIFICATIONS, type RecordedVerification } from './plan.js';
import { loadReleaseRoster, type ReleaseRoster } from './queries.js';
import { residueOf } from './residue.js';
import { type LiveState, readLiveState, type VerifyConfig } from './verify.js';
import { attemptsOf } from './versions.js';

interface ReleaseRunState {
  runId: string;
  projectId: string;
  runStatus: string;
  /** Why a run that ended `failed` failed, as its close recorded it; null on every other run (ISS-928). */
  failure: RunFailure | null;
  /** The roster issues a release that shipped could not close, waiting to close into it (ISS-928). */
  residue: string[];
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
  verification: RecordedVerification | null;
  /** `null` when the run never announced one. */
  method: ReleaseMethod | null;
  /** True when the agent announced that it could not load its method. */
  methodUnloaded: boolean;
  /** The last finish attempt, `null` before the first `finish` call. */
  finish: ReleaseFinishRecord | null;
  /** The kept probes a release replayed before releases closed on the agent's record (2026-11-01);
   *  null on every release since, which replays none. */
  probeReplay: ProbeReplayRecord | null;
}

/** What an earlier release recorded of its probe replay, kept as it was written. */
function readProbeReplay(metadata: Record<string, unknown>): ProbeReplayRecord | null {
  const value = metadata.probeReplay;
  return value && typeof value === 'object' ? (value as ProbeReplayRecord) : null;
}

/** The probes production declares, read for this state's live line only: no close reads them. */
function liveProbes(channels: ReleaseChannel[]): VerifyConfig | null {
  return channels.find((c) => c.verify !== null)?.verify ?? null;
}

/** The run's own record of how its close is proved, stamped at create and again at the close. */
function recordedVerification(
  meta: Record<string, unknown>,
  runId: string,
): RecordedVerification | null {
  const value = meta.verification;
  if (value === undefined || value === null) return null;
  if ((RECORDED_VERIFICATIONS as readonly unknown[]).includes(value)) {
    return value as RecordedVerification;
  }
  throw new Error(
    `release run ${runId} records verification ${JSON.stringify(value)}, which is none of ${RECORDED_VERIFICATIONS.join(', ')}`,
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
    attemptsOf([runId]),
    verify ? readLiveState(verify) : Promise.resolve(null),
  ]);
  const run = (await readRun(runId)) ?? first;
  const meta = (run.metadata ?? {}) as Record<string, unknown>;
  const method = readMethod(meta);

  return {
    runId,
    projectId: run.projectId,
    runStatus: run.status,
    failure: readRunFailure(meta),
    residue: residueOf(meta),
    version: run.releaseVersion,
    roster,
    attempts,
    live,
    verification: recordedVerification(meta, runId),
    method,
    methodUnloaded: method !== null && !method.loaded,
    finish: readFinishRecord(meta),
    probeReplay: readProbeReplay(meta),
  };
}
