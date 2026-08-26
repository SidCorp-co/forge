/**
 * ISS-449 (ISS-442 C3 / invariant I3) — the closed job loop.
 *
 * Models the job lifecycle as four hops — dispatch → ack → heartbeat →
 * result — each with ONE timeout and exactly ONE miss-handler, all reaps
 * routed through the same `finalizeFailedJob` tail as a runner-reported
 * failure. The PRIMARY reaper for non-progressing kernel state; the legacy
 * sweepers in `pipeline/sweeper.ts` / `jobs/stale-detector.ts` are demoted to
 * alarm-only (`loop-miss`) coverage-proof passes.
 *
 * JOB-axis hops (dispatch→ack, session_lost, result-stale) are two-phase via
 * `jobs/kill-gate.ts` (ISS-785): request-kill, then fail only once confirmed
 * — see the design doc for the hop table and the kill-gate rationale.
 *
 * Full hop table + the ISS-785 kill-gate model:
 * docs/architecture/job-loop-monitor.md
 */

import type { SQL } from 'drizzle-orm';
import { and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, jobs, pipelineRuns } from '../db/schema.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { failureStamp } from '../pipeline/failure-classifier.js';
import { emitPipelineWedge, type WedgeHop } from '../pipeline/wedge.js';
import { broadcastSessionEvent } from './agent-session-link.js';
import { finalizeFailedJob } from './finalize-failure.js';
import {
  isKillEpisodeLive,
  type KillableJobRef,
  killGraceMs,
  requestJobKill,
  resolveKillConfirmation,
} from './kill-gate.js';
import { LAST_PHASE_CTE, LAST_PROGRESS_AT } from './progress-signal.js';

// Lazily loaded (ISS-584 B). schedules/dispatch.js pulls a heavy prompt-builder
// chain (and through it the env-validating embeddings module); importing it
// statically here would drag that into every consumer of the loop-monitor (and
// break hermetic unit suites that don't stub env). The sweeper only needs it at
// runtime, so resolve it on first use and cache.
type RedispatchFn = (
  sessionId: string,
) => Promise<{ ok: boolean; status: string; sessionId?: string; deviceId?: string }>;
type JobRow = typeof jobs.$inferSelect;

let _redispatchScheduleFn: RedispatchFn | null = null;
async function getRedispatchScheduleFn(): Promise<RedispatchFn> {
  if (!_redispatchScheduleFn) {
    const mod = await import('../schedules/dispatch.js');
    _redispatchScheduleFn = mod.redispatchScheduleSessionOnFailover;
  }
  return _redispatchScheduleFn;
}

// Hop thresholds. Clamped at MIN_TIMEOUT_MS so a low env override can't
// slaughter healthy rows. Values + env names carried over from the demoted
// sweepers so existing deploy configs keep working:
//   - queue (claim hop):      PIPELINE_QUEUE_TIMEOUT_MS      (ISS-232: 2 min)
//   - heartbeat hop:          PIPELINE_HEARTBEAT_TIMEOUT_MS  (3 min)
//   - ack hop:                PIPELINE_NEVER_CLAIMED_MS      (ISS-378: 3 min)
const QUEUE_TIMEOUT_MS_DEFAULT = 120_000;
const HEARTBEAT_TIMEOUT_MS_DEFAULT = 3 * 60_000;
const ACK_TIMEOUT_MS_DEFAULT = 3 * 60_000;
const MIN_TIMEOUT_MS = 30_000;
// ISS-584 (C): fast-fail grace for a chat/schedule session that the runner ACKed
// (positive "I got it") but that never produced a claudeSessionId — claude died
// on startup. Short because the ack already proved a live runner; only a dead
// claude leaves claudeSessionId NULL past this window. Not-acked sessions keep
// the conservative heartbeat timeout (rollout-safe for runners without ack).
const ACK_FAST_MS_DEFAULT = 90_000;

/** Result-hop quiet threshold (was runStaleSweep's STALE_THRESHOLD; ISS-258
 *  bumped 5→60 min because legit forge-release/forge-code merges run >5min
 *  between event emissions). Exported so the demoted stale-detector alarm can
 *  derive its margin from the same number. */
// cm:guard never lower RESULT_QUIET_MINUTES — legitimate release/code merges run long and get reaped as orphans
export const RESULT_QUIET_MINUTES = 60;

const PIPELINE_METADATA_TYPES = sql`('pipeline','pm')`;

function readTimeoutEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_TIMEOUT_MS ? n : fallback;
}

export function getLoopThresholds(): {
  queueMs: number;
  heartbeatMs: number;
  ackMs: number;
  ackFastMs: number;
} {
  return {
    queueMs: readTimeoutEnv('PIPELINE_QUEUE_TIMEOUT_MS', QUEUE_TIMEOUT_MS_DEFAULT),
    heartbeatMs: readTimeoutEnv('PIPELINE_HEARTBEAT_TIMEOUT_MS', HEARTBEAT_TIMEOUT_MS_DEFAULT),
    ackMs: readTimeoutEnv('PIPELINE_NEVER_CLAIMED_MS', ACK_TIMEOUT_MS_DEFAULT),
    ackFastMs: readTimeoutEnv('PIPELINE_ACK_FAST_MS', ACK_FAST_MS_DEFAULT),
  };
}

export interface LoopScope {
  projectId?: string;
}

export interface ZombieSessionReapResult {
  queueTimedOut: number;
  heartbeatTimedOut: number;
  noClientAcked: number;
}

/** ISS-785 — every job-axis hop now reports three counts instead of one:
 *  `reaped` (confirmed dead, terminal write applied — same meaning the bare
 *  number used to have), plus the two intermediate outcomes of the kill gate
 *  so callers/tests can see the gate is actually engaging. */
export interface JobAxisReapResult {
  reaped: number;
  killRequested: number;
  awaitingKill: number;
}

export interface LoopMonitorResult {
  /** dispatch→ack misses reaped (`dispatch_unclaimed`). */
  ackMisses: JobAxisReapResult;
  /** Session-level claim/heartbeat misses reaped. */
  sessions: ZombieSessionReapResult;
  /** Jobs failed because their linked session is terminal (`session_lost`). */
  sessionLostJobs: JobAxisReapResult;
  /** result-hop misses reaped (`stale`, no event for RESULT_QUIET_MINUTES). */
  resultMisses: JobAxisReapResult;
}

/** Resolve the linked issue for a session's wedge event via its pipeline_run
 *  (sessions carry no issue_id of their own). Best-effort. */
async function lookupIssueForRun(pipelineRunId: string | null): Promise<string | null> {
  if (!pipelineRunId) return null;
  try {
    const [row] = await db
      .select({ issueId: pipelineRuns.issueId })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, pipelineRunId))
      .limit(1);
    return row?.issueId ?? null;
  } catch {
    return null;
  }
}

/** Raw-execute candidate row shared by every job-axis hop — the columns the
 *  kill gate needs (`toKillableRef`) plus the identifiers a wedge needs.
 *  A `type` (not `interface`) — `db.execute<T>`'s `T extends Record<string,
 *  unknown>` constraint only structurally matches object-literal types. */
type KillGateCandidateRow = {
  id: string;
  project_id: string;
  issue_id: string | null;
  device_id: string | null;
  runner_id: string | null;
  kill_requested_at: Date | string | null;
  kill_confirmed_at: Date | string | null;
  kill_outcome: JobRow['killOutcome'];
};

function toKillableRef(row: KillGateCandidateRow): KillableJobRef {
  return {
    id: row.id,
    deviceId: row.device_id,
    runnerId: row.runner_id,
    killRequestedAt: row.kill_requested_at ? new Date(row.kill_requested_at) : null,
    killConfirmedAt: row.kill_confirmed_at ? new Date(row.kill_confirmed_at) : null,
    killOutcome: row.kill_outcome,
  };
}

type KillGateReapDecision =
  | { phase: 'kill_requested' }
  | { phase: 'awaiting_kill' }
  | { phase: 'lost_race' }
  | { phase: 'reaped'; updated: JobRow; confirmed: boolean };

interface KillGateReapConfig {
  hop: WedgeHop;
  /** CAS predicate for the terminal flip — MUST include the same status
   *  guard the candidate SELECT used. */
  where: SQL | undefined;
  fromStatus: string;
  /** Written to `jobs.error` — also the SYNTHETIC_REAP_ERRORS marker the
   *  late-`/complete` reconciler matches on, so keep it the short form. */
  error: string;
  /** Passed to `finalizeFailedJob`'s `error` option (logging / classifier
   *  fallback only). Defaults to `error` when the hop has no longer text. */
  finalizeError?: string;
  failureKind: 'infra' | 'timeout';
  failureReason: string;
  /** What tripped the hop — true on both the confirmed and unconfirmed
   *  branch, so the unconfirmed wedge extends it rather than replacing it. */
  wedgeReason: string;
  /** Action text for the CONFIRMED branch only (a retry is in flight). The
   *  unconfirmed branch owns `UNCONFIRMED_WEDGE_ACTION`. */
  confirmedWedgeAction: string;
  /**
   * Hop 1 (ack) only: the candidate predicate already proves no runner ever
   * claimed the job (`acked_at IS NULL`, zero job_events), so there is no
   * process to confirm dead — treat silence past the grace as confirmed
   * instead of falling through to `resolveKillConfirmation` (which would
   * park at `waiting` on every ordinary never-claimed dispatch, defeating
   * the hop's fast-failover contract).
   */
  forceConfirmAfterGrace?: boolean;
}

/**
 * ISS-785 — shared two-phase gate + CAS for every job-axis hop. Tick 1 (no
 * `killRequestedAt` yet): request the kill, wedge, and leave the job active.
 * Tick 2+ within the grace: no-op, wait. Tick 2+ past the grace: resolve
 * confirmation and CAS the job to `failed` exactly as the pre-ISS-785 code
 * did. Deliberately stops at the CAS — the caller increments its `reaped`
 * counter and THEN calls `finalizeKillGateReap` for the wedge + retry tail,
 * mirroring the pre-ISS-785 ordering where a throw from `finalizeFailedJob`
 * must not un-count a row whose terminal write already committed (see the
 * per-row error-isolation tests).
 */
async function resolveKillGateDecision(
  row: KillGateCandidateRow,
  cfg: KillGateReapConfig,
): Promise<KillGateReapDecision> {
  const ref = toKillableRef(row);

  const requestedAt = ref.killRequestedAt;
  if (!requestedAt || !isKillEpisodeLive(ref)) {
    // cm:guard no wedge here — nothing is actionable until the kill is confirmed or times out; a wedge now would occupy the per-entity dedupe slot (wedge.ts) and swallow the actionable phase-2 wedge below
    // cm:guard an aged-out request opens a NEW episode (requestJobKill clears the old answer) — reading it as "phase 1 already done" would fail+retry a job whose runner was never told to stop this time round
    await requestJobKill(ref, cfg.error);
    return { phase: 'kill_requested' };
  }

  if (Date.now() - requestedAt.getTime() < killGraceMs()) {
    // cm:why re-publish job.cancel on every tick while awaiting confirmation — a WS blip that drops the first publish must not park a job whose runner reconnects before the grace elapses; idempotent, the runner answers not_found
    await requestJobKill(ref, cfg.error);
    return { phase: 'awaiting_kill' };
  }

  let confirmed: boolean;
  let outcome: JobRow['killOutcome'];
  if (cfg.forceConfirmAfterGrace) {
    confirmed = true;
    // cm:guard record never_claimed, NOT not_found — no runner answered, and an audit column that invents an answer is the state-never-lies violation (VISION §10) this gate exists to prevent
    outcome = ref.killOutcome ?? 'never_claimed';
  } else {
    const resolution = await resolveKillConfirmation(ref);
    confirmed = resolution.confirmed;
    outcome = resolution.outcome;
  }

  const set: Partial<Omit<JobRow, 'id' | 'status'>> = {
    error: cfg.error,
    finishedAt: new Date(),
    ...failureStamp(cfg.failureKind, cfg.failureReason),
  };
  if (confirmed) set.killConfirmedAt = new Date();
  if (outcome) set.killOutcome = outcome;

  const [updated] = await applyKernelTransition(db, {
    entity: 'job',
    to: 'failed',
    set,
    where: cfg.where,
    fromStatus: cfg.fromStatus,
    reason: cfg.error,
    actor: { type: 'sweeper' },
    source: 'loop-monitor',
  });
  if (!updated) return { phase: 'lost_race' };

  return { phase: 'reaped', updated, confirmed };
}

// cm:guard the unconfirmed park is the ONE reap outcome with no retry and a possibly-live agent — its wedge must never reuse the confirmed branch's "routed to retry" text, or the operator reads "handled" and leaves the process writing git (VISION §10)
const UNCONFIRMED_WEDGE_ACTION =
  'NO retry was scheduled and the issue is parked at `waiting`. Before resuming it, check the assigned device and kill any agent process still running for this job — resuming while it lives puts two agents on the same worktree.';

/** Wedge + route the confirmed/unconfirmed reap through the shared
 *  `finalizeFailedJob` tail — retry forced off when the kill was never
 *  confirmed. Called AFTER the row is already counted `reaped` (see above). */
async function finalizeKillGateReap(
  updated: JobRow,
  confirmed: boolean,
  cfg: Pick<
    KillGateReapConfig,
    'hop' | 'error' | 'finalizeError' | 'wedgeReason' | 'confirmedWedgeAction'
  >,
): Promise<void> {
  await emitPipelineWedge({
    projectId: updated.projectId,
    issueId: updated.issueId,
    hop: cfg.hop,
    entity: 'job',
    entityId: updated.id,
    reason: confirmed
      ? cfg.wedgeReason
      : `${cfg.wedgeReason} — and the runner never confirmed the kill, so its agent process may still be running on the device`,
    action: confirmed ? cfg.confirmedWedgeAction : UNCONFIRMED_WEDGE_ACTION,
  });
  const finalizeError = cfg.finalizeError ?? cfg.error;
  await finalizeFailedJob(
    updated,
    confirmed
      ? { error: finalizeError }
      : {
          error: finalizeError,
          precomputedRetry: { scheduled: false, reason: 'kill_unconfirmed' },
        },
  );
}

/**
 * Hop 1 — dispatch→ack. A `dispatched` job that was never acked and emitted
 * zero events past the grace window: no runner claimed it. CAS on
 * `status='dispatched'` so a runner that acks in the same instant wins.
 *
 * ISS-785 — still two-phase (a kill is requested before the job fails), but
 * the candidate predicate itself proves no process exists, so confirmation
 * is forced true once the grace elapses (see
 * `KillGateReapConfig.forceConfirmAfterGrace`) — this hop now fails at
 * `ackMs + killGraceMs()` instead of `ackMs` alone.
 */
export async function reapAckMisses(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<JobAxisReapResult> {
  const { ackMs } = getLoopThresholds();
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
  const cutoffIso = new Date(now.getTime() - ackMs).toISOString();
  const candidates = await db.execute<KillGateCandidateRow>(sql`
    SELECT j.id, j.project_id, j.issue_id, j.device_id, j.runner_id,
           j.kill_requested_at, j.kill_confirmed_at, j.kill_outcome
    FROM jobs j
    WHERE j.status = 'dispatched'
      AND j.acked_at IS NULL
      AND j.dispatched_at IS NOT NULL
      AND j.dispatched_at < ${cutoffIso}
      AND NOT EXISTS (
        SELECT 1 FROM job_events e WHERE e.job_id = j.id
      )
      ${projectClause}
  `);

  const result: JobAxisReapResult = { reaped: 0, killRequested: 0, awaitingKill: 0 };
  for (const row of candidates) {
    try {
      const cfg: KillGateReapConfig = {
        hop: 'ack',
        where: and(eq(jobs.id, row.id), eq(jobs.status, 'dispatched')),
        fromStatus: 'dispatched',
        error: 'dispatch_unclaimed',
        failureKind: 'infra',
        failureReason:
          'dispatch never claimed by a runner (no ack / no started event within grace window)',
        wedgeReason:
          'runner never acked the dispatch (no ack, zero job events) within the grace window',
        confirmedWedgeAction:
          'Check the assigned device is online and its forge-runner daemon is running. The job was auto-failed and routed to device-rotated retry; if it recurs, rotate or unbind the device.',
        forceConfirmAfterGrace: true,
      };
      const decision = await resolveKillGateDecision(row, cfg);
      if (decision.phase === 'kill_requested') result.killRequested++;
      else if (decision.phase === 'awaiting_kill') result.awaitingKill++;
      else if (decision.phase === 'reaped') {
        result.reaped++;
        await finalizeKillGateReap(decision.updated, decision.confirmed, cfg);
      }
    } catch (err) {
      logger.error({ err, jobId: row.id }, 'loop-monitor: ack-miss reap failed (row skipped)');
    }
  }

  if (result.reaped > 0) {
    logger.info({ reaped: result.reaped }, 'loop-monitor: ack-hop misses reaped to failed');
  }
  return result;
}

/**
 * Hops 2–3a/b (session axis) — claim + heartbeat. The three zombie passes
 * moved verbatim from pipeline/sweeper.ts `sweepZombieSessions` (ISS-232 /
 * ISS-280 / ISS-420 semantics preserved), now emitting a wedge per reap.
 * Also serves the manual `/agent-sessions/sweep-zombies` endpoint via `scope`.
 */
export async function reapZombieSessions(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<ZombieSessionReapResult> {
  const { queueMs, heartbeatMs, ackFastMs } = getLoopThresholds();
  const queueCutoff = new Date(now.getTime() - queueMs);
  const heartbeatCutoff = new Date(now.getTime() - heartbeatMs);
  // ISO string, NOT a Date: this cutoff is bound inside a raw `sql` COALESCE
  // template (below), where drizzle has no column type to serialise a Date
  // against — postgres-js then throws `TypeError: ... Received an instance of
  // Date` on bind, aborting the loop monitor (the sweep's first pass) and, pre
  // per-pass isolation, every reaper after it. The column-based `lt()` cutoffs
  // above are fine (drizzle knows the column type); only this template needs ISO.
  const ackFastCutoffIso = new Date(now.getTime() - ackFastMs).toISOString();
  const projectFilter = scope.projectId ? eq(agentSessions.projectId, scope.projectId) : undefined;

  // Claim hop: queued past timeout. CAS via WHERE status='queued' so a worker
  // that claims concurrently isn't stomped. dispatchedAt falls back to
  // createdAt for rows that pre-date the migration.
  const queuedFailed = await applyKernelTransition(db, {
    entity: 'session',
    to: 'failed',
    set: { failureReason: 'queue_timeout', updatedAt: now },
    where: and(
      eq(agentSessions.status, 'queued'),
      or(
        and(isNotNull(agentSessions.dispatchedAt), lt(agentSessions.dispatchedAt, queueCutoff)),
        and(sql`${agentSessions.dispatchedAt} IS NULL`, lt(agentSessions.createdAt, queueCutoff)),
      ),
      sql`${agentSessions.metadata}->>'type' IN ${PIPELINE_METADATA_TYPES}`,
      ...(projectFilter ? [projectFilter] : []),
    ),
    fromStatus: 'queued',
    reason: 'queue_timeout',
    actor: { type: 'sweeper' },
    source: 'loop-monitor',
  });

  for (const z of queuedFailed) {
    broadcastZombieTransition(z.id, z.projectId, z.deviceId, 'queue_timeout');
    await emitPipelineWedge({
      projectId: z.projectId,
      issueId: await lookupIssueForRun(z.pipelineRunId),
      hop: 'claim',
      entity: 'session',
      entityId: z.id,
      reason: 'no worker claimed the session within the queue timeout',
      action:
        'Check that an online runner is bound to this project. The session was failed; the job axis recovers via the heartbeat hop + retry.',
    });
  }

  // Heartbeat hop (pipeline/pm, + ISS-675 escalation, + ISS-727 agent-chat):
  // running with stale heartbeat. Falls back through startedAt → updatedAt →
  // createdAt so a rolling deploy with workers still running older code
  // doesn't over-sweep. A RocketChat escalation or agent-chat session
  // (metadata.escalation or metadata.agentChat set, no metadata.type) rides
  // the SAME runner heartbeat mechanism as a pipeline/pm session, so it must
  // match here too — otherwise an attached-then-hung runner (claudeSessionId
  // already set, so the no_client_ack hop below can never claim it) leaves
  // the session `running` forever: no completion bridge fires (silence in
  // the room) and the per-rid dedup never clears.
  const heartbeatFailed = await applyKernelTransition(db, {
    entity: 'session',
    to: 'failed',
    set: { failureReason: 'heartbeat_timeout', updatedAt: now },
    where: and(
      eq(agentSessions.status, 'running'),
      or(
        and(
          isNotNull(agentSessions.lastHeartbeatAt),
          lt(agentSessions.lastHeartbeatAt, heartbeatCutoff),
        ),
        and(
          sql`${agentSessions.lastHeartbeatAt} IS NULL`,
          isNotNull(agentSessions.startedAt),
          lt(agentSessions.startedAt, heartbeatCutoff),
          lt(agentSessions.updatedAt, heartbeatCutoff),
        ),
        and(
          sql`${agentSessions.lastHeartbeatAt} IS NULL`,
          sql`${agentSessions.startedAt} IS NULL`,
          lt(agentSessions.updatedAt, heartbeatCutoff),
          lt(agentSessions.createdAt, heartbeatCutoff),
        ),
      ),
      or(
        sql`${agentSessions.metadata}->>'type' IN ${PIPELINE_METADATA_TYPES}`,
        sql`${agentSessions.metadata} -> 'escalation' IS NOT NULL`,
        sql`${agentSessions.metadata} -> 'agentChat' IS NOT NULL`,
      ),
      ...(projectFilter ? [projectFilter] : []),
    ),
    fromStatus: 'running',
    reason: 'heartbeat_timeout',
    actor: { type: 'sweeper' },
    source: 'loop-monitor',
  });

  for (const z of heartbeatFailed) {
    broadcastZombieTransition(z.id, z.projectId, z.deviceId, 'heartbeat_timeout');
    await emitPipelineWedge({
      projectId: z.projectId,
      issueId: await lookupIssueForRun(z.pipelineRunId),
      hop: 'heartbeat',
      entity: 'session',
      entityId: z.id,
      reason: 'worker claimed the session but its heartbeat went stale',
      action:
        'Check the device: is the forge-runner daemon alive, did the Claude CLI process die? The job axis recovers via session-lost reap + retry.',
    });
  }

  // No-client hop (ISS-420): a chat/schedule/agent session created `running`
  // that never got a working client — claudeSessionId still NULL and the
  // heartbeat never advanced past creation. COALESCE so a NULL/absent
  // metadata.type (plain chat, schedule.run) counts as "not pipeline/pm".
  const noClientFailed = await applyKernelTransition(db, {
    entity: 'session',
    to: 'failed',
    set: { failureReason: 'no_client_ack', updatedAt: now },
    where: and(
      eq(agentSessions.status, 'running'),
      sql`${agentSessions.claudeSessionId} IS NULL`,
      sql`COALESCE(${agentSessions.metadata}->>'type','') NOT IN ${PIPELINE_METADATA_TYPES}`,
      or(
        // ISS-584 (C) fast path: the runner ACKed (a live client received the
        // turn) but claude never emitted a session id within the short grace →
        // claude died on startup. Positive ack evidence, so a SHORT window is
        // safe (no false-positive on runners that don't ack — they fall through
        // to the conservative heartbeat branches below).
        and(
          sql`${agentSessions.metadata}->>'acked' = 'true'`,
          sql`COALESCE(${agentSessions.dispatchedAt}, ${agentSessions.createdAt}) < ${ackFastCutoffIso}`,
        ),
        and(
          isNotNull(agentSessions.lastHeartbeatAt),
          lt(agentSessions.lastHeartbeatAt, heartbeatCutoff),
        ),
        and(
          sql`${agentSessions.lastHeartbeatAt} IS NULL`,
          lt(agentSessions.createdAt, heartbeatCutoff),
        ),
      ),
      ...(projectFilter ? [projectFilter] : []),
    ),
    fromStatus: 'running',
    reason: 'no_client_ack',
    actor: { type: 'sweeper' },
    source: 'loop-monitor',
  });

  for (const z of noClientFailed) {
    broadcastZombieTransition(z.id, z.projectId, z.deviceId, 'no_client_ack');
    // ISS-584 (B): a schedule run that never attached ran zero side effects, so
    // it is safe to re-dispatch onto another runner (async failover, mirrors the
    // job reaper→retry model). Plain chat returns `not-schedule` and is left for
    // the user to retry. Best-effort: a throw here must not abort the sweep.
    let failover: { ok: boolean; sessionId?: string; deviceId?: string } | null = null;
    try {
      const redispatch = await getRedispatchScheduleFn();
      failover = await redispatch(z.id);
      if (failover.ok) {
        logger.info(
          {
            failedSessionId: z.id,
            retrySessionId: failover.sessionId,
            deviceId: failover.deviceId,
          },
          'loop-monitor: schedule no_client_ack re-dispatched to another runner',
        );
      }
    } catch (err) {
      logger.error({ err, sessionId: z.id }, 'loop-monitor: schedule failover threw (skipped)');
    }
    // A successful failover already re-queued the work, so the wedge would be
    // noise; only flag the genuine dead-ends (no device left / chain exhausted /
    // plain chat) that still need a human or device.
    if (!failover?.ok) {
      await emitPipelineWedge({
        projectId: z.projectId,
        issueId: await lookupIssueForRun(z.pipelineRunId),
        hop: 'claim',
        entity: 'session',
        entityId: z.id,
        reason: 'session was created running but no client ever attached (no claudeSessionId)',
        action:
          'Check that the target device is online and accepting agent:start. Re-run the schedule/chat turn once a device is available.',
      });
    }
  }

  const result: ZombieSessionReapResult = {
    queueTimedOut: queuedFailed.length,
    heartbeatTimedOut: heartbeatFailed.length,
    noClientAcked: noClientFailed.length,
  };

  if (result.queueTimedOut > 0 || result.heartbeatTimedOut > 0 || result.noClientAcked > 0) {
    logger.info({ ...result, queueMs, heartbeatMs }, 'loop-monitor: zombie sessions failed');
  }

  return result;
}

/**
 * Hop 3c (job axis) — session-lost propagation. When a linked session is
 * terminal but its job is still active (and never emitted a `result` event),
 * kill-gate it and route the confirmed reap through the shared finalize
 * tail. Moved from pipeline/sweeper.ts `reconcileOrphanedJobs` (ISS-280
 * semantics preserved, incl. the result-event false-positive guard).
 *
 * ISS-37 lived here: the session heartbeat hop had already failed the
 * linked session while the job's own process kept running, and this hop —
 * pre-kill-gate — failed the job on the very same read, letting the retry it
 * scheduled dispatch a second agent onto the still-live worktree.
 */
export async function reapSessionLostJobs(
  _now: Date = new Date(),
  scope: LoopScope = {},
): Promise<JobAxisReapResult> {
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
  const candidates = await db.execute<KillGateCandidateRow>(sql`
    SELECT j.id, j.project_id, j.issue_id, j.device_id, j.runner_id,
           j.kill_requested_at, j.kill_confirmed_at, j.kill_outcome
    FROM jobs j
    JOIN agent_sessions s ON s.id = j.agent_session_id
    WHERE j.status IN ('dispatched', 'running')
      AND s.status IN ('failed', 'cancelled_stale')
      AND NOT EXISTS (
        SELECT 1 FROM job_events e
        WHERE e.job_id = j.id AND e.kind = 'result'
      )
      ${projectClause}
  `);

  const result: JobAxisReapResult = { reaped: 0, killRequested: 0, awaitingKill: 0 };
  for (const row of candidates) {
    try {
      const cfg: KillGateReapConfig = {
        hop: 'heartbeat',
        where: and(eq(jobs.id, row.id), inArray(jobs.status, ['dispatched', 'running'])),
        fromStatus: 'active',
        error: 'session_lost',
        failureKind: 'infra',
        failureReason:
          'agent session terminated without job completion (silent runner/agent death)',
        wedgeReason: 'linked agent session terminated without the job reporting completion',
        confirmedWedgeAction:
          'The job was failed and routed to retry. If retries keep landing here, inspect the device runner logs for silent deaths.',
      };
      const decision = await resolveKillGateDecision(row, cfg);
      if (decision.phase === 'kill_requested') result.killRequested++;
      else if (decision.phase === 'awaiting_kill') result.awaitingKill++;
      else if (decision.phase === 'reaped') {
        result.reaped++;
        await finalizeKillGateReap(decision.updated, decision.confirmed, cfg);
      }
    } catch (err) {
      logger.error({ err, jobId: row.id }, 'loop-monitor: session-lost reap failed (row skipped)');
    }
  }

  if (result.reaped > 0) {
    logger.info({ reaped: result.reaped }, 'loop-monitor: session-lost jobs reconciled to failed');
  }
  return result;
}

/**
 * Hop 4 — result. A claimed job whose latest event (or dispatch, if events
 * are gone quiet entirely) is older than RESULT_QUIET_MINUTES and that never
 * emitted a `result` event: the worker is wedged. Moved from
 * jobs/stale-detector.ts `runStaleSweep` (ISS-258 semantics preserved, incl.
 * the result-event finalize-drop guard), now ticking every minute.
 */
export async function reapResultMisses(
  _now: Date = new Date(),
  scope: LoopScope = {},
): Promise<JobAxisReapResult> {
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
  const candidates = await db.execute<KillGateCandidateRow>(sql`
    WITH last_event AS (
      SELECT job_id, MAX(ts) AS max_ts
      FROM job_events
      GROUP BY job_id
    ), ${LAST_PHASE_CTE}
    SELECT j.id, j.project_id, j.issue_id, j.device_id, j.runner_id,
           j.kill_requested_at, j.kill_confirmed_at, j.kill_outcome
    FROM jobs j
    LEFT JOIN last_event le ON le.job_id = j.id
    LEFT JOIN last_phase lp ON lp.run_id = j.pipeline_run_id
    WHERE j.status IN ('dispatched', 'running')
      AND NOT EXISTS (
        SELECT 1 FROM job_events
        WHERE job_id = j.id AND kind = 'result'
      )
      AND ${LAST_PROGRESS_AT} < now() - interval '${sql.raw(String(RESULT_QUIET_MINUTES))} minutes'
      ${projectClause}
  `);

  const STALE_REASON = `runner stale (no progress / no started event for >${RESULT_QUIET_MINUTES}min)`;
  const result: JobAxisReapResult = { reaped: 0, killRequested: 0, awaitingKill: 0 };
  for (const row of candidates) {
    try {
      const cfg: KillGateReapConfig = {
        hop: 'result',
        where: and(eq(jobs.id, row.id), inArray(jobs.status, ['dispatched', 'running'])),
        fromStatus: 'active',
        error: 'stale',
        finalizeError: STALE_REASON,
        failureKind: 'timeout',
        failureReason: STALE_REASON,
        wedgeReason: STALE_REASON,
        confirmedWedgeAction:
          'The job was failed and routed to a device-rotated retry. Check the original device for a hung Claude CLI / runaway step.',
      };
      const decision = await resolveKillGateDecision(row, cfg);
      if (decision.phase === 'kill_requested') result.killRequested++;
      else if (decision.phase === 'awaiting_kill') result.awaitingKill++;
      else if (decision.phase === 'reaped') {
        result.reaped++;
        await finalizeKillGateReap(decision.updated, decision.confirmed, cfg);
      }
    } catch (err) {
      logger.error({ err, jobId: row.id }, 'loop-monitor: result-miss reap failed (row skipped)');
    }
  }

  if (result.reaped > 0) {
    logger.info({ reaped: result.reaped }, 'loop-monitor: result-hop misses reaped to failed');
  }
  return result;
}

/**
 * One loop tick: every hop once, in dependency order — ack first (frees
 * never-claimed dispatches fast), then the session hops, then session-lost
 * propagation (so a session failed THIS tick immediately frees its job/runner
 * slot — ISS-280 same-tick propagation preserved), then the result hop.
 */
export async function runLoopMonitor(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<LoopMonitorResult> {
  const ackMisses = await reapAckMisses(now, scope);
  const sessions = await reapZombieSessions(now, scope);
  const sessionLostJobs = await reapSessionLostJobs(now, scope);
  const resultMisses = await reapResultMisses(now, scope);
  return { ackMisses, sessions, sessionLostJobs, resultMisses };
}

function broadcastZombieTransition(
  sessionId: string,
  projectId: string,
  deviceId: string | null,
  reason: 'queue_timeout' | 'heartbeat_timeout' | 'no_client_ack',
): void {
  broadcastSessionEvent(sessionId, projectId, deviceId, 'agent-session.status', {
    status: 'failed',
    failureReason: reason,
  });
}
