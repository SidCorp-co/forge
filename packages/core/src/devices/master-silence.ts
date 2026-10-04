import { type SQL, sql } from 'drizzle-orm';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import { SESSION_SILENCE_TIMEOUT_S } from './session-silence.js';

const TERMINAL = sql.raw(terminalAgentSessionStatuses.map((s) => `'${s}'`).join(', '));

// cm:why the reaper and masters/standing share one "last spoke": the master's beat or a live child's REPORTED beat
// (a child that beat means a live box); never a child's created_at, as prepare mints a queued child at once
export function masterLastBeatSql(alias: string): SQL {
  const s = sql.raw(alias);
  return sql`GREATEST(
    COALESCE(${s}.last_heartbeat_at, ${s}.started_at, ${s}.created_at),
    (SELECT max(COALESCE(c.last_heartbeat_at, c.started_at))
       FROM agent_sessions c
      WHERE c.parent_session_id = ${s}.id
        AND c.status NOT IN (${TERMINAL}))
  )`;
}

export function masterSilentSql(alias: string): SQL {
  return sql`${masterLastBeatSql(alias)} < now() - make_interval(secs => ${SESSION_SILENCE_TIMEOUT_S})`;
}
