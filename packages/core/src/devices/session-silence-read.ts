import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import { getLoopThresholds } from '../jobs/loop-monitor-thresholds.js';
import { parkedOnAHuman } from '../jobs/park-deadline.js';
import { type OneShotSibling, silenceLimitMs } from './session-silence.js';

const TERMINAL = sql.raw(terminalAgentSessionStatuses.map((s) => `'${s}'`).join(', '));

interface SilenceRow {
  id: string;
  kind: string;
  runtime_state: string | null;
  metadata: unknown;
  child_lead_ms: number | string | null;
  one_shot: OneShotSibling[] | null;
}

/**
 * Each session's silence limit, read from the rows every reaper's eligibility reads, so the sessions
 * list, the session page, the Pipeline page and the runs tab all count to the one number core keeps.
 */
export async function loadSilenceLimits(
  ids: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, number | null>> {
  if (ids.length === 0) return new Map();
  const runnerCutoff = new Date(now.getTime() - getLoopThresholds().heartbeatMs).toISOString();
  const rows = (await db.execute(sql`
    WITH subject AS (
      SELECT s.id, s.kind, s.runtime_state, s.pipeline_run_id,
             COALESCE(s.last_heartbeat_at, s.started_at, s.created_at) AS beat,
             (SELECT jsonb_object_agg(m.key, m.value)
                FROM jsonb_each(CASE WHEN jsonb_typeof(s.metadata) = 'object' THEN s.metadata ELSE '{}'::jsonb END) m
               WHERE m.key IN ('escalation', 'agentChat')) AS metadata
        FROM agent_sessions s
       WHERE s.id IN (${sql.join(
         ids.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
    )
    SELECT x.id, x.kind, x.runtime_state, x.metadata,
           (SELECT EXTRACT(EPOCH FROM MAX(COALESCE(c.last_heartbeat_at, c.started_at)) - x.beat) * 1000
              FROM agent_sessions c
             WHERE c.parent_session_id = x.id AND c.status NOT IN (${TERMINAL})) AS child_lead_ms,
           (SELECT jsonb_agg(jsonb_build_object(
                     'leadMs', EXTRACT(EPOCH FROM COALESCE(t.last_heartbeat_at, t.started_at, t.updated_at, t.created_at) - x.beat) * 1000,
                     'runnerAnswers', EXISTS (SELECT 1 FROM runners rn
                                               WHERE rn.device_id = t.device_id AND rn.last_seen_at >= ${runnerCutoff}),
                     'parked', ${parkedOnAHuman(sql`t.id`)}))
              FROM pipeline_runs r
              JOIN agent_sessions t ON t.pipeline_run_id = r.id AND t.status IN ('queued', 'running', 'idle')
             WHERE r.id = x.pipeline_run_id
               AND r.kind IN ('system', 'interactive')
               AND r.status IN ('running', 'paused')
               AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.pipeline_run_id = r.id)) AS one_shot
      FROM subject x
  `)) as unknown as SilenceRow[];
  return new Map(
    rows.map((r) => [
      r.id,
      silenceLimitMs({
        kind: r.kind,
        runtimeState: r.runtime_state,
        metadata: r.metadata,
        childLeadMs: r.child_lead_ms === null ? null : Number(r.child_lead_ms),
        oneShot: r.one_shot?.map((t) => ({ ...t, leadMs: Number(t.leadMs) })) ?? null,
      }),
    ]),
  );
}
