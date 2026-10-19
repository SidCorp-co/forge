/**
 * Whether anything is alive on a run: its unheld live jobs, the newest heartbeat of any live
 * session on it, what its agent is doing, and — for a resident master's run (ISS-1335) — the live
 * master session itself.
 * Read by both run lists, so the REST row and the MCP row cannot answer differently.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, jobs, pipelineRuns, terminalAgentSessionStatuses } from '../db/schema.js';
import { MASTER_SESSION_METADATA_TYPE } from '../devices/run-session-keys.js';
import { CHAT_SESSION_KIND } from '../jobs/session-kinds.js';
import { UNHELD_LIVE_JOB_STATUSES } from '../jobs/status-sets.js';
import type { PipelineRunLane, ResidentMaster } from './runs-lane.js';

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

const sqlList = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

/** What a run's agent is doing, the one reading every surface shows (ISS-1228): `running` once a job
 *  runs or a session core holds running has beaten, `starting` where a box has taken or been sent a
 *  job it has not started or a queued session beats, `waiting` where only a chat waits on its
 *  person's reply, `queued` where only a job nobody has taken waits, `null` where nothing is live. */
export type RunReading = 'running' | 'starting' | 'waiting' | 'queued';

export function readingOf(counts: {
  running: number;
  starting: number;
  queued: number;
  runningSessions: number;
  startingSessions: number;
  waitingChats: number;
}): RunReading | null {
  if (counts.running > 0 || counts.runningSessions > 0) return 'running';
  if (counts.starting > 0 || counts.startingSessions > 0) return 'starting';
  if (counts.waitingChats > 0) return 'waiting';
  return counts.queued > 0 ? 'queued' : null;
}

export interface RunLiveness {
  liveJobs: number;
  beat: string | null;
  reading: RunReading | null;
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
    running_sessions: number | string;
    starting_sessions: number | string;
    waiting_chats: number | string;
    last_beat: Date | string | null;
    master_session_id?: string | null;
    master_name?: string | null;
    master_beat?: Date | string | null;
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
      (SELECT count(*) FROM ${agentSessions} s
        WHERE s.pipeline_run_id = r.id AND s.status = 'running'
          AND s.last_heartbeat_at IS NOT NULL) AS running_sessions,
      (SELECT count(*) FROM ${agentSessions} s
        WHERE s.pipeline_run_id = r.id AND s.status = 'queued'
          AND s.last_heartbeat_at IS NOT NULL) AS starting_sessions,
      (SELECT count(*) FROM ${agentSessions} s
        WHERE s.pipeline_run_id = r.id AND s.kind = ${CHAT_SESSION_KIND}
          AND s.status = 'idle') AS waiting_chats,
      (SELECT max(s.last_heartbeat_at) FROM ${agentSessions} s
        WHERE s.pipeline_run_id = r.id
          AND s.status NOT IN (${sqlList(terminalAgentSessionStatuses)})) AS last_beat,
      m.id AS master_session_id,
      m.name AS master_name,
      m.last_heartbeat_at AS master_beat
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
    WHERE r.id IN (${sqlList(runIds)})
  `);
  for (const r of rows) {
    if (!r.run_id) continue;
    const beat = toIso(r.last_beat);
    out.set(r.run_id, {
      liveJobs: Number(r.live_jobs),
      beat,
      reading: readingOf({
        running: Number(r.running_jobs),
        starting: Number(r.starting_jobs),
        queued: Number(r.untaken_jobs),
        runningSessions: Number(r.running_sessions),
        startingSessions: Number(r.starting_sessions),
        waitingChats: Number(r.waiting_chats),
      }),
      master: r.master_session_id
        ? {
            sessionId: r.master_session_id,
            name: r.master_name ?? null,
            lastHeartbeatAt: toIso(r.master_beat ?? null),
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
