import { type SQL, sql } from 'drizzle-orm';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import { SESSION_SILENCE_TIMEOUT_S } from './session-silence.js';

const TERMINAL = sql.raw(terminalAgentSessionStatuses.map((s) => `'${s}'`).join(', '));

// cm:why one reading of "the master's box last spoke": its own beat or the latest a live child REPORTED,
// so the reaper that fails a silent master and the board that says silent apply the same rule
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
