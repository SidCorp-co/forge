import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/session-vocabulary.js';
import { parkedOnAHuman, residencySeconds } from '../jobs/park-deadline.js';
import { silenceLimitMs } from './session-silence.js';

const TERMINAL = sql.raw(terminalAgentSessionStatuses.map((s) => `'${s}'`).join(', '));

type Ms = number | string | null;

interface SilenceRow {
  id: string;
  kind: string;
  status: string;
  runtime_state: string | null;
  metadata: unknown;
  has_client: boolean;
  last_heartbeat_at: Ms;
  started_at: Ms;
  updated_at: Ms;
  created_at: Ms;
  dispatched_at: Ms;
  parked: boolean;
  has_job: boolean;
  residency_s: number | string;
  latest_child_beat_at: Ms;
  run_started_at: Ms;
  one_shot: Array<{
    beatAt: number | string;
    runnerSeenAt: number | string | null;
    parked: boolean;
  }> | null;
}

const ms = (v: Ms): number | null => (v === null ? null : Number(v));
const epoch = (col: string) => sql.raw(`EXTRACT(EPOCH FROM ${col}) * 1000`);

/**
 * Each session's silence limit, read from the rows every reaper's eligibility reads, so the sessions
 * list, the session page, the Pipeline page and the runs tab all count to the one number core keeps.
 */
export async function loadSilenceLimits(
  ids: readonly string[],
): Promise<Map<string, number | null>> {
  if (ids.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT s.id, s.kind, s.status, s.runtime_state, s.claude_session_id IS NOT NULL AS has_client,
           (SELECT jsonb_object_agg(m.key, m.value)
              FROM jsonb_each(CASE WHEN jsonb_typeof(s.metadata) = 'object' THEN s.metadata ELSE '{}'::jsonb END) m
             WHERE m.key IN ('escalation', 'agentChat', 'acked', 'source')) AS metadata,
           ${epoch('s.last_heartbeat_at')} AS last_heartbeat_at, ${epoch('s.started_at')} AS started_at,
           ${epoch('s.updated_at')} AS updated_at, ${epoch('s.created_at')} AS created_at,
           ${epoch('s.dispatched_at')} AS dispatched_at,
           ${parkedOnAHuman(sql`s.id`)} AS parked,
           EXISTS (SELECT 1 FROM jobs j WHERE j.agent_session_id = s.id) AS has_job,
           ${residencySeconds(sql`s.project_id`)} AS residency_s,
           (SELECT ${epoch('MAX(COALESCE(c.last_heartbeat_at, c.started_at))')}
              FROM agent_sessions c
             WHERE c.parent_session_id = s.id AND c.status NOT IN (${TERMINAL})) AS latest_child_beat_at,
           ${epoch('r.started_at')} AS run_started_at,
           (SELECT jsonb_agg(jsonb_build_object(
                     'beatAt', ${epoch('COALESCE(t.last_heartbeat_at, t.started_at, t.updated_at, t.created_at)')},
                     'runnerSeenAt', (SELECT ${epoch('MAX(rn.last_seen_at)')}
                                        FROM runners rn WHERE rn.device_id = t.device_id),
                     'parked', ${parkedOnAHuman(sql`t.id`)}))
              FROM agent_sessions t
             WHERE t.pipeline_run_id = r.id AND t.status IN ('queued', 'running', 'idle')) AS one_shot
      FROM agent_sessions s
      LEFT JOIN pipeline_runs r
             ON r.id = s.pipeline_run_id
            AND r.kind IN ('system', 'interactive')
            AND r.status IN ('running', 'paused')
            AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.pipeline_run_id = r.id)
     WHERE s.id IN (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
  `)) as unknown as SilenceRow[];
  return new Map(
    rows.map((r) => {
      const runStartedAt = ms(r.run_started_at);
      return [
        r.id,
        silenceLimitMs({
          kind: r.kind,
          status: r.status,
          runtimeState: r.runtime_state,
          metadata: r.metadata,
          hasClient: r.has_client,
          lastHeartbeatAt: ms(r.last_heartbeat_at),
          startedAt: ms(r.started_at),
          updatedAt: Number(r.updated_at),
          createdAt: Number(r.created_at),
          dispatchedAt: ms(r.dispatched_at),
          parked: r.parked,
          hasJob: r.has_job,
          residencyMs: Number(r.residency_s) * 1000,
          latestChildBeatAt: ms(r.latest_child_beat_at),
          oneShot:
            runStartedAt === null
              ? null
              : {
                  runStartedAt,
                  sessions: (r.one_shot ?? []).map((t) => ({
                    parked: t.parked,
                    beatAt: Number(t.beatAt),
                    runnerSeenAt: t.runnerSeenAt === null ? null : Number(t.runnerSeenAt),
                  })),
                },
        }),
      ];
    }),
  );
}
