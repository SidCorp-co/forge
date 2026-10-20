/** A run's attempts, one per job on it, sourced from `jobs` so the `retry_of` chain and the box each
 *  landed on are visible beside the round-robin headline (ISS-411). */

import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, devices, jobs } from '../db/schema.js';
import { RETRY_MAX_ROUNDS, readAutoRetryPayload } from '../jobs/retry.js';
import { isoOrNull } from '../lib/iso-time.js';
import { personNameSql } from '../lib/person-name.js';
import { DOOR_DECIDED_CAUSES, type FailureCause } from './failure-causes.js';
import { causeForText } from './failure-patterns.js';
import { holdOf, type RunHold } from './runs-liveness.js';

/** The box a held, unstarted job is on: the box its own session was opened on, else its holder's. */
const takenDevice = sql<
  string | null
>`CASE WHEN ${jobs.status} = 'queued' AND ${jobs.heldBy} IS NOT NULL
  THEN COALESCE(${agentSessions.deviceId},
                (SELECT h.device_id FROM agent_sessions h WHERE h.id = ${jobs.heldBy})) END`;

/**
 * The newest cancel of the job, else of its run: who wrote it, and the name the person gave where a
 * person did — never their address, which reads as the unnamed person (ISS-1229).
 */
const cancelActor = sql<{
  type: string;
  agency: string;
  id: string | null;
  name: string | null;
} | null>`(
  SELECT json_build_object('type', t.actor_type, 'agency', t.actor_agency, 'id', u.id,
                           'name', CASE WHEN u.id IS NULL THEN NULL
                                        ELSE ${personNameSql(sql`u.display_name`)} END)
    FROM kernel_transitions t
    LEFT JOIN users u ON u.id = t.actor_id
   WHERE t.to_status = 'cancelled'
     AND ((t.entity = 'job' AND t.entity_id = ${jobs.id})
       OR (t.entity = 'run' AND t.entity_id = ${jobs.pipelineRunId}))
   ORDER BY (t.actor_type = 'user') DESC, (t.entity = 'job') DESC, t.created_at DESC
   LIMIT 1)`;

/** Who cancelled a job: a person or an agent by the account that did, else core itself. The account's
 *  id goes with its name, so a reader can say "you" to the one who cancelled it. */
export function cancelledByOf(
  actor: { type: string; agency: string; id?: string | null; name: string | null } | null,
): PipelineRunAttempt['cancelledBy'] {
  if (actor?.type !== 'user') return { kind: 'core', userId: null, name: null };
  return {
    kind: actor.agency === 'agent' ? 'agent' : 'person',
    userId: actor.id ?? null,
    name: actor.name ?? null,
  };
}

/** A failed job no session ended: the cause core's classifier reads off what the sweeper wrote on it. */
function sweptCause(
  status: string,
  reason: string | null,
  error: string | null,
): FailureCause | null {
  if (status !== 'failed') return null;
  const cause = causeForText([reason, error].filter(Boolean).join(' — '));
  return cause === 'unclassified' ? null : cause;
}


export interface PipelineRunAttempt {
  jobId: string;
  jobType: string;
  status: string;
  attempts: number;
  retryOf: string | null;
  deviceId: string | null;
  deviceName: string | null;
  failureReason: string | null;
  /** The linked session's cause token; null where none was reached or classified. */
  failureCause: string | null;
  failureDetail: string | null;
  failureKind: 'code' | 'infra' | 'transient-cc' | 'timeout' | null;
  failureAction: 'terminal' | 'quarantine' | 'failover' | 'retry' | null;
  queuedAt: string | null;
  startedAt: string | null;
  /** When the attempt's own session first reported its agent working; null where it never did. */
  ranAt: string | null;
  finishedAt: string | null;
  autoRetry: { round: number; target: string | null; tries: number; done: string[] } | null;
  /** The box whose session holds the job before it starts: a taken job is never "unassigned". */
  takenBy: { deviceId: string; deviceName: string | null } | null;
  /** Why core holds the job and whether it sends it again by itself; null unless it is held. */
  hold: RunHold | null;
  /** Who cancelled the job or its run; null unless it was cancelled. */
  cancelledBy: {
    kind: 'person' | 'agent' | 'core';
    userId: string | null;
    name: string | null;
  } | null;
}

/** The round-robin headline, from the newest attempt's `_autoRetry`. */
export interface PipelineRunRetrySummary {
  totalAttempts: number;
  round: number;
  maxRounds: number;
  targetDeviceId: string | null;
  targetDeviceName: string | null;
}

/** One run's attempts oldest first; `_autoRetry` is absent on rows older than ISS-407. */
export async function loadAttemptsForRun(runId: string): Promise<{
  attempts: PipelineRunAttempt[];
  retrySummary: PipelineRunRetrySummary | null;
}> {
  const rows = await db
    .select({
      jobId: jobs.id,
      jobType: jobs.type,
      status: jobs.status,
      attempts: jobs.attempts,
      retryOf: jobs.retryOf,
      deviceId: jobs.deviceId,
      deviceName: devices.name,
      failureReason: jobs.failureReason,
      error: jobs.error,
      failureKind: jobs.failureKind,
      failureAction: jobs.failureAction,
      failureCause: agentSessions.failureReason,
      failureDetail: agentSessions.failureDetail,
      queuedAt: jobs.queuedAt,
      startedAt: jobs.dispatchedAt,
      ranAt: agentSessions.startedAt,
      finishedAt: jobs.finishedAt,
      retryAfterAt: jobs.retryAfterAt,
      payload: jobs.payload,
      cancelActor,
      takenDeviceId: takenDevice,
      takenDeviceName: sql<
        string | null
      >`(SELECT d.name FROM devices d WHERE d.id = ${takenDevice})`,
    })
    .from(jobs)
    .leftJoin(devices, eq(devices.id, jobs.deviceId))
    .leftJoin(agentSessions, eq(agentSessions.id, jobs.agentSessionId))
    .where(eq(jobs.pipelineRunId, runId))
    .orderBy(asc(jobs.queuedAt));

  const nameById = new Map<string, string>();
  for (const r of rows) {
    if (r.deviceId && r.deviceName) nameById.set(r.deviceId, r.deviceName);
  }

  const attempts: PipelineRunAttempt[] = rows.map((r) => {
    const hasAutoRetry =
      !!r.payload &&
      typeof r.payload === 'object' &&
      '_autoRetry' in (r.payload as Record<string, unknown>);
    const ar = hasAutoRetry ? readAutoRetryPayload(r.payload) : null;
    const cancelled = r.status === 'cancelled';
    return {
      jobId: r.jobId,
      jobType: r.jobType,
      status: r.status,
      attempts: r.attempts ?? 0,
      retryOf: r.retryOf ?? null,
      deviceId: r.deviceId ?? null,
      deviceName: r.deviceName ?? null,
      failureReason: r.failureReason ?? null,
      // A cancel is the job's own end: a session an earlier take ended is not why it stopped. A cause
      // the job's door decided is the job's word, whatever its session row was classified as.
      failureCause: cancelled
        ? null
        : r.failureReason && DOOR_DECIDED_CAUSES.has(r.failureReason)
          ? r.failureReason
          : (r.failureCause ?? sweptCause(r.status, r.failureReason, r.error)),
      failureDetail: cancelled ? null : (r.failureDetail ?? null),
      failureKind: r.failureKind ?? null,
      failureAction: r.failureAction ?? null,
      queuedAt: isoOrNull(r.queuedAt),
      startedAt: isoOrNull(r.startedAt),
      ranAt: isoOrNull(r.ranAt),
      finishedAt: isoOrNull(r.finishedAt),
      autoRetry: ar,
      takenBy: r.takenDeviceId
        ? { deviceId: r.takenDeviceId, deviceName: r.takenDeviceName ?? null }
        : null,
      hold:
        r.status === 'held'
          ? holdOf({
              payload: r.payload,
              failureReason: r.failureReason ?? null,
              retryAfterAt: isoOrNull(r.retryAfterAt),
              since: isoOrNull(r.queuedAt),
            })
          : null,
      cancelledBy: cancelled ? cancelledByOf(r.cancelActor ?? null) : null,
    } satisfies PipelineRunAttempt;
  });

  let retrySummary: PipelineRunRetrySummary | null = null;
  for (let i = attempts.length - 1; i >= 0; i--) {
    const ar = attempts[i]?.autoRetry;
    if (ar) {
      retrySummary = {
        totalAttempts: attempts.length,
        round: ar.round,
        maxRounds: RETRY_MAX_ROUNDS,
        targetDeviceId: ar.target,
        targetDeviceName: ar.target ? (nameById.get(ar.target) ?? null) : null,
      };
      break;
    }
  }
  // The box a retry targets need not be one an attempt ran on: its name is read, never its id shown.
  if (retrySummary?.targetDeviceId && retrySummary.targetDeviceName === null) {
    const [box] = await db
      .select({ name: devices.name })
      .from(devices)
      .where(eq(devices.id, retrySummary.targetDeviceId));
    retrySummary.targetDeviceName = box?.name ?? null;
  }

  return { attempts, retrySummary };
}
