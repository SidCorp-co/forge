import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/session-vocabulary.js';
import { parkedOnAHuman, residencySeconds } from '../jobs/park-deadline.js';
import { LIVE_SESSION_STATUSES } from '../lifecycle/status-sets.js';
import { type SilenceSubject, silenceDeadline } from './session-silence.js';

const TERMINAL_SQL = sql.raw(terminalAgentSessionStatuses.map((s) => `'${s}'`).join(', '));
const LIVE_SQL = sql.raw(LIVE_SESSION_STATUSES.map((s) => `'${s}'`).join(', '));
const LIVE: ReadonlySet<string> = new Set(LIVE_SESSION_STATUSES);
const TERMINAL: ReadonlySet<string> = new Set(terminalAgentSessionStatuses);

type Ms = number | string | null;

interface SilenceRow {
  id: string;
  pipeline_run_id: string | null;
  parent_session_id: string | null;
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
  sweep_beat_at: Ms;
  runner_seen_at: Ms;
  run_started_at: Ms;
}

const ms = (v: Ms): number | null => (v === null ? null : Number(v));
const epoch = (col: string) => sql.raw(`FLOOR(EXTRACT(EPOCH FROM ${col}) * 1000)`);

function subjectOf(r: SilenceRow): SilenceSubject {
  return {
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
  };
}

/** The sessions whose silence decides theirs: siblings on one run, a master's children, owners. */
async function readClosure(ids: readonly string[]): Promise<SilenceRow[]> {
  const wanted = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  return (await db.execute(sql`
    WITH RECURSIVE closure(id) AS (
      SELECT id FROM agent_sessions WHERE id IN (${wanted})
      UNION
      SELECT t.id
        FROM closure c
        JOIN agent_sessions s ON s.id = c.id
        JOIN agent_sessions t
          ON (t.pipeline_run_id = s.pipeline_run_id AND t.status IN (${LIVE_SQL}))
          OR (t.parent_session_id = s.id AND t.status NOT IN (${TERMINAL_SQL}))
          OR t.id = s.parent_session_id
    )
    SELECT s.id, s.pipeline_run_id, s.parent_session_id, s.kind, s.status, s.runtime_state,
           s.claude_session_id IS NOT NULL AS has_client,
           (SELECT jsonb_object_agg(m.key, m.value)
              FROM jsonb_each(CASE WHEN jsonb_typeof(s.metadata) = 'object' THEN s.metadata ELSE '{}'::jsonb END) m
             WHERE m.key IN ('escalation', 'agentChat', 'acked', 'source')) AS metadata,
           ${epoch('s.last_heartbeat_at')} AS last_heartbeat_at, ${epoch('s.started_at')} AS started_at,
           ${epoch('s.updated_at')} AS updated_at, ${epoch('s.created_at')} AS created_at,
           ${epoch('s.dispatched_at')} AS dispatched_at,
           ${parkedOnAHuman(sql`s.id`)} AS parked,
           EXISTS (SELECT 1 FROM jobs j WHERE j.agent_session_id = s.id) AS has_job,
           ${residencySeconds(sql`s.project_id`)} AS residency_s,
           ${epoch('COALESCE(s.last_heartbeat_at, s.started_at, s.updated_at, s.created_at)')} AS sweep_beat_at,
           (SELECT ${epoch('MAX(rn.last_seen_at)')} FROM runners rn WHERE rn.device_id = s.device_id) AS runner_seen_at,
           ${epoch('r.started_at')} AS run_started_at
      FROM agent_sessions s
      LEFT JOIN pipeline_runs r
             ON r.id = s.pipeline_run_id
            AND r.kind IN ('system', 'interactive')
            AND r.status IN ('running', 'paused')
            AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.pipeline_run_id = r.id)
     WHERE s.id IN (SELECT id FROM closure)
  `)) as unknown as SilenceRow[];
}

function group(rows: readonly SilenceRow[], key: (r: SilenceRow) => string | null) {
  const out = new Map<string, SilenceRow[]>();
  for (const r of rows) {
    const k = key(r);
    if (k !== null) out.set(k, [...(out.get(k) ?? []), r]);
  }
  return out;
}

/**
 * When core ends each session if nothing more is heard, read from the rows every reaper's eligibility
 * reads, so the sessions list, the session page, the Pipeline page and the runs tab count to one time.
 * A session another one holds up — a sibling on a jobless one-shot run, a master's child — holds it
 * only until a reaper ends that one.
 */
export async function loadSilenceDeadlines(
  ids: readonly string[],
): Promise<Map<string, number | null>> {
  if (ids.length === 0) return new Map();
  const rows = await readClosure(ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const oneShotRuns = group(rows, (r) =>
    r.run_started_at !== null && LIVE.has(r.status) ? r.pipeline_run_id : null,
  );
  const children = group(rows, (r) => (TERMINAL.has(r.status) ? null : r.parent_session_id));

  const memo = new Map<string, number | null>();
  const open = new Set<string>();
  let reentered = 0;
  const remember = (key: string, compute: () => number | null): number | null => {
    if (memo.has(key)) return memo.get(key) ?? null;
    if (open.has(key)) {
      reentered += 1;
      return null;
    }
    open.add(key);
    const before = reentered;
    const found = compute();
    open.delete(key);
    // A value read through a cycle is provisional, so only one computed without one is kept.
    if (reentered === before) memo.set(key, found);
    return found;
  };
  const earliest = (...ends: Array<number | null>): number | null => {
    const known = ends.filter((e): e is number => e !== null);
    return known.length === 0 ? null : Math.min(...known);
  };
  const owner = (r: SilenceRow): SilenceRow | undefined => {
    const p = r.parent_session_id === null ? undefined : byId.get(r.parent_session_id);
    return p && !TERMINAL.has(p.status) ? p : undefined;
  };
  // Its own reapers; `final` adds its owners', whose end closes it too (session-descent).
  const own = (id: string, withSweep: boolean): number | null =>
    remember(`own:${id}:${withSweep}`, () => {
      const r = byId.get(id);
      if (!r) return null;
      const runStartedAt = ms(r.run_started_at);
      const siblings = r.pipeline_run_id === null ? [] : (oneShotRuns.get(r.pipeline_run_id) ?? []);
      return silenceDeadline({
        ...subjectOf(r),
        children: (children.get(id) ?? []).map((c) => ({
          beatAt: ms(c.last_heartbeat_at) ?? ms(c.started_at),
          endsBy: own(c.id, true),
        })),
        oneShot:
          !withSweep || runStartedAt === null
            ? null
            : {
                runStartedAt,
                sessions: siblings.map((t) => {
                  const above = owner(t);
                  return {
                    beatAt: Number(t.sweep_beat_at),
                    runnerSeenAt: ms(t.runner_seen_at),
                    parked: t.parked,
                    endsBy: earliest(own(t.id, false), above ? final(above.id) : null),
                  };
                }),
              },
      });
    });
  const final = (id: string): number | null =>
    remember(`final:${id}`, () => {
      const r = byId.get(id);
      if (!r || TERMINAL.has(r.status)) return null;
      const above = owner(r);
      return earliest(own(id, true), above ? final(above.id) : null);
    });
  return new Map(ids.filter((id) => byId.has(id)).map((id) => [id, final(id)]));
}
