/**
 * Whether anything is alive on a run: its unheld live jobs, the newest heartbeat of any live
 * session on it, what its agent is doing, and — for a resident master's run (ISS-1335) — the live
 * master session itself.
 * Read by both run lists, so the REST row and the MCP row cannot answer differently.
 */

import { inArray, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, jobs, pipelineRuns, terminalAgentSessionStatuses } from '../db/schema.js';
import { agentQuestions } from '../db/schema-questions.js';
import { deviceRunLedger } from '../db/schema-run-ledger.js';
import { MASTER_SESSION_METADATA_TYPE } from '../devices/run-session-keys.js';
import { SESSION_SILENCE_TIMEOUT_S } from '../devices/session-silence.js';
import { AUTO_RELEASE_REASONS, HOLD_PAYLOAD_KEY, readHoldState } from '../jobs/hold-state.js';
import { CHAT_SESSION_KIND, RUN_SESSION_KIND } from '../jobs/session-kinds.js';
import { UNHELD_LIVE_JOB_STATUSES } from '../jobs/status-sets.js';
import { isoOrNull } from '../lib/iso-time.js';
import { questionIdsFor } from '../questions/pane-question-id.js';
import type { PipelineRunLane, ResidentMaster } from './runs-lane.js';

const sqlList = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

/** What a run's agent is doing, the one reading every surface shows (ISS-1228): `blocked` where a
 *  box reports a session core still holds blocked, `running` once a job runs or a session core holds
 *  running has checked in, `starting` where a box has taken or been sent a job it has not started or
 *  a session has not yet checked in, `waiting` where only a chat waits on its person's reply,
 *  `queued` where only a job nobody has taken waits, `held` where only a job core holds waits;
 *  with nothing live, `asking` where its newest job stopped on a question that stands and `answered`
 *  once a person answered it, else `null` — a question voided or expired leaves the run its status. */
export type RunReading =
  | 'blocked'
  | 'running'
  | 'starting'
  | 'waiting'
  | 'queued'
  | 'held'
  | 'asking'
  | 'answered';

/** Where the question a run's newest job stopped on stands with a person. */
type QuestionReading = 'asking' | 'answered';

export function readingOf(counts: {
  blocked?: boolean;
  running: number;
  starting: number;
  queued: number;
  held?: number;
  runningSessions: number;
  startingSessions: number;
  waitingChats: number;
  question?: QuestionReading | null;
}): RunReading | null {
  if (counts.blocked) return 'blocked';
  if (counts.running > 0 || counts.runningSessions > 0) return 'running';
  if (counts.starting > 0 || counts.startingSessions > 0) return 'starting';
  if (counts.waitingChats > 0) return 'waiting';
  if (counts.queued > 0) return 'queued';
  if ((counts.held ?? 0) > 0) return 'held';
  return counts.question ?? null;
}

const STANDING_QUESTION = new Set(['open', 'needs_info']);

/** Per run whose newest job stopped on a question, whether one of its questions stands or was answered. */
async function questionReadings(
  newest: ReadonlyMap<string, string>,
): Promise<Map<string, QuestionReading>> {
  const runOf = new Map<string, string>();
  for (const [runId, jobId] of newest) for (const id of questionIdsFor(jobId)) runOf.set(id, runId);
  const out = new Map<string, QuestionReading>();
  if (runOf.size === 0) return out;
  const asked = await db
    .select({ id: agentQuestions.id, status: agentQuestions.status })
    .from(agentQuestions)
    .where(inArray(agentQuestions.id, [...runOf.keys()]));
  for (const q of asked) {
    const runId = runOf.get(q.id) as string;
    if (STANDING_QUESTION.has(q.status)) out.set(runId, 'asking');
    else if (q.status === 'answered' && !out.has(runId)) out.set(runId, 'answered');
  }
  return out;
}

/** Why core holds a run's job and whether it sends it again by itself (`jobs/hold.ts`). */
export interface RunHold {
  reason: string;
  resumesItself: boolean;
  /** When core next tries a hold that waits out a clock; null where it waits on a condition. */
  recheckAt: string | null;
  since: string | null;
}

/**
 * A job held on a hold that clears by itself — the SQL reading of `holdOf`'s `resumesItself`. The
 * hold re-queues that job on its own recheck, so the issue is not stuck: a rescue would wake the
 * masters for nothing, and three of them parked the issue for a person under a comment saying
 * nothing worked on it while its run read Held (ISS-1228).
 */
export function holdResumesItselfSql(job: SQL) {
  const reasons = sql.join(
    [...AUTO_RELEASE_REASONS].map((r) => sql`${r}`),
    sql`, `,
  );
  const hold = sql`${job}.payload -> ${HOLD_PAYLOAD_KEY}`;
  return sql`(${job}.status = 'held'
    AND COALESCE(${hold} ->> 'reason', ${job}.failure_reason) IN (${reasons})
    AND COALESCE((${hold} ->> 'autoRelease')::boolean, ${hold} IS NULL))`;
}

/** A held job's hold, read off its row: the reason its payload names, else the row's own. */
export function holdOf(row: {
  payload: unknown;
  failureReason: string | null;
  retryAfterAt: string | null;
  since: string | null;
}): RunHold | null {
  const state = readHoldState(row.payload);
  const reason = state?.reason ?? row.failureReason;
  if (!reason) return null;
  return {
    reason,
    resumesItself: AUTO_RELEASE_REASONS.has(reason) && (state === null || state.autoRelease),
    recheckAt: row.retryAfterAt,
    since: row.since,
  };
}

/** Who a box says its blocked run waits on, and whether its process has gone (a park). */
export interface RunBlock {
  blockerKind: string | null;
  parked: boolean;
}

export interface RunLiveness {
  liveJobs: number;
  beat: string | null;
  reading: RunReading | null;
  /** The newest held job's hold, where the run holds one. */
  hold: RunHold | null;
  /** What the box reports its blocked session waits on, where it reports one. */
  block: RunBlock | null;
  /** When core ends a session on the run that has not checked in since it opened, if none comes. */
  checkInBy: string | null;
  /** The earliest start of any session on the run, ended ones included: when its work started. */
  runningSince: string | null;
  /** The run's newest session, whose page says what it is doing. */
  sessionId: string | null;
  /** The newest live `kind = 'master'` session on the run, whatever its lane. */
  master: ResidentMaster | null;
}

/**
 * Run liveness for many runs, in ONE statement. `live_jobs` asks
 * {@link UNHELD_LIVE_JOB_STATUSES} rather than `jobs/status-sets.ts`'s
 * `LIVE_JOB_STATUSES`: a run whose only job is parked on a person is not work
 * in flight, and counting it would keep that run out of the stalled band.
 * `last_beat` is any live session's; the master columns are a live master's
 * alone, so another session cannot vouch for a dead one.
 */
export async function loadRunLivenessByRunIds(runIds: string[]): Promise<Map<string, RunLiveness>> {
  const out = new Map<string, RunLiveness>();
  if (runIds.length === 0) return out;
  const rows = await db.execute<{
    run_id: string;
    live_jobs: number | string;
    running_jobs: number | string;
    starting_jobs: number | string;
    untaken_jobs: number | string;
    held_jobs: number | string;
    running_sessions: number | string;
    starting_sessions: number | string;
    waiting_chats: number | string;
    last_beat: Date | string | null;
    hold_payload: unknown;
    hold_reason: string | null;
    hold_recheck_at: Date | string | null;
    hold_since: Date | string | null;
    blocked: boolean | null;
    blocker_kind: string | null;
    blocked_incarnation: string | null;
    check_in_by: Date | string | null;
    running_since: Date | string | null;
    session_id: string | null;
    master_session_id?: string | null;
    master_name?: string | null;
    master_beat?: Date | string | null;
    asked_job_id?: string | null;
  }>(sql`
    SELECT
      r.id AS run_id,
      (SELECT count(*) FROM ${jobs} j
        WHERE j.pipeline_run_id = r.id
          AND j.status IN (${sqlList(UNHELD_LIVE_JOB_STATUSES)})) AS live_jobs,
      (SELECT count(*) FROM ${jobs} j
        WHERE j.pipeline_run_id = r.id AND j.status = 'running') AS running_jobs,
      (SELECT count(*) FROM ${jobs} j
        WHERE j.pipeline_run_id = r.id
          AND (j.status = 'dispatched' OR (j.status = 'queued' AND j.held_by IS NOT NULL))) AS starting_jobs,
      (SELECT count(*) FROM ${jobs} j
        WHERE j.pipeline_run_id = r.id AND j.status = 'queued' AND j.held_by IS NULL) AS untaken_jobs,
      (SELECT count(*) FROM ${jobs} j
        WHERE j.pipeline_run_id = r.id AND j.status = 'held') AS held_jobs,
      (SELECT count(*) FROM ${agentSessions} s
        WHERE s.pipeline_run_id = r.id AND s.status = 'running'
          AND NOT (s.kind = ${RUN_SESSION_KIND} AND s.started_at IS NULL)
          AND s.last_heartbeat_at IS NOT NULL) AS running_sessions,
      (SELECT count(*) FROM ${agentSessions} s
        WHERE s.pipeline_run_id = r.id
          AND ((s.status = 'queued' AND s.last_heartbeat_at IS NOT NULL)
               OR (s.status = 'running' AND s.kind = ${RUN_SESSION_KIND}
                   AND s.started_at IS NULL))) AS starting_sessions,
      (SELECT min(COALESCE(s.last_heartbeat_at, s.created_at)
                  + make_interval(secs => ${SESSION_SILENCE_TIMEOUT_S}))
         FROM ${agentSessions} s
        WHERE s.pipeline_run_id = r.id AND s.status = 'running'
          AND s.kind = ${RUN_SESSION_KIND} AND s.started_at IS NULL) AS check_in_by,
      (SELECT min(s.started_at) FROM ${agentSessions} s
        WHERE s.pipeline_run_id = r.id) AS running_since,
      (SELECT s.id FROM ${agentSessions} s
        WHERE s.pipeline_run_id = r.id
        ORDER BY s.created_at DESC LIMIT 1) AS session_id,
      h.payload AS hold_payload,
      h.failure_reason AS hold_reason,
      h.retry_after_at AS hold_recheck_at,
      h.queued_at AS hold_since,
      b.blocked,
      b.blocker_kind,
      b.incarnation AS blocked_incarnation,
      (SELECT count(*) FROM ${agentSessions} s
        WHERE s.pipeline_run_id = r.id AND s.kind = ${CHAT_SESSION_KIND}
          AND s.status = 'idle') AS waiting_chats,
      (SELECT max(s.last_heartbeat_at) FROM ${agentSessions} s
        WHERE s.pipeline_run_id = r.id
          AND s.status NOT IN (${sqlList(terminalAgentSessionStatuses)})) AS last_beat,
      m.id AS master_session_id,
      m.name AS master_name,
      m.last_heartbeat_at AS master_beat,
      (SELECT CASE WHEN j.failure_reason = 'stopped_on_question' THEN j.id END FROM ${jobs} j
        WHERE j.pipeline_run_id = r.id
        ORDER BY j.queued_at DESC NULLS LAST LIMIT 1) AS asked_job_id
    FROM ${pipelineRuns} r
    LEFT JOIN LATERAL (
      SELECT s.id, s.metadata->>'terminalName' AS name, s.last_heartbeat_at
        FROM ${agentSessions} s
       WHERE s.pipeline_run_id = r.id
         AND s.kind = ${MASTER_SESSION_METADATA_TYPE}
         AND s.status NOT IN (${sqlList(terminalAgentSessionStatuses)})
       ORDER BY s.started_at DESC NULLS LAST
       LIMIT 1
    ) m ON true
    LEFT JOIN LATERAL (
      SELECT j.payload, j.failure_reason, j.retry_after_at, j.queued_at
        FROM ${jobs} j
       WHERE j.pipeline_run_id = r.id AND j.status = 'held'
       ORDER BY j.queued_at DESC NULLS LAST
       LIMIT 1
    ) h ON true
    LEFT JOIN LATERAL (
      SELECT true AS blocked, l.blocker_kind, l.incarnation
        FROM ${deviceRunLedger} l
        JOIN ${agentSessions} s ON s.id = l.session_id
       WHERE s.pipeline_run_id = r.id
         AND l.work = 'blocked'
         AND s.status NOT IN (${sqlList(terminalAgentSessionStatuses)})
       ORDER BY l.observed_at DESC
       LIMIT 1
    ) b ON true
    WHERE r.id IN (${sqlList(runIds)})
  `);
  const question = await questionReadings(
    new Map(rows.flatMap((r) => (r.run_id && r.asked_job_id ? [[r.run_id, r.asked_job_id]] : []))),
  );
  for (const r of rows) {
    if (!r.run_id) continue;
    const beat = isoOrNull(r.last_beat);
    out.set(r.run_id, {
      liveJobs: Number(r.live_jobs),
      beat,
      reading: readingOf({
        blocked: r.blocked === true,
        running: Number(r.running_jobs),
        starting: Number(r.starting_jobs),
        queued: Number(r.untaken_jobs),
        held: Number(r.held_jobs),
        runningSessions: Number(r.running_sessions),
        startingSessions: Number(r.starting_sessions),
        waitingChats: Number(r.waiting_chats),
        question: question.get(r.run_id) ?? null,
      }),
      hold:
        Number(r.held_jobs) > 0
          ? holdOf({
              payload: r.hold_payload,
              failureReason: r.hold_reason,
              retryAfterAt: isoOrNull(r.hold_recheck_at),
              since: isoOrNull(r.hold_since),
            })
          : null,
      block:
        r.blocked === true
          ? { blockerKind: r.blocker_kind, parked: r.blocked_incarnation === 'exited' }
          : null,
      checkInBy: isoOrNull(r.check_in_by),
      runningSince: isoOrNull(r.running_since),
      sessionId: r.session_id,
      master: r.master_session_id
        ? {
            sessionId: r.master_session_id,
            name: r.master_name ?? null,
            lastHeartbeatAt: isoOrNull(r.master_beat ?? null),
          }
        : null,
    });
  }
  return out;
}

/** ISS-1335 — gated on the lane, so no row off it can be read as a master's. */
export function residentMasterOn(
  lane: PipelineRunLane,
  liveness: RunLiveness | undefined,
): ResidentMaster | null {
  return lane === 'master' ? (liveness?.master ?? null) : null;
}
