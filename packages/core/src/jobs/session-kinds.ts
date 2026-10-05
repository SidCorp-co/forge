/**
 * Which species of session a query is asking about. `agent_sessions.kind` is
 * the column; these are the sets, and the SQL below is built from them.
 */
import { type SQL, sql } from 'drizzle-orm';
import type { AgentSessionKind } from '../db/schema.js';
import { kindTuple, PIPELINE_SESSION_KINDS } from '../db/session-vocabulary.js';

export {
  CLIENT_SESSION_KINDS,
  kindTuple,
  PIPELINE_SESSION_KINDS,
} from '../db/session-vocabulary.js';

export const NEVER_PARKED_SESSION_KINDS = ['master'] as const satisfies readonly AgentSessionKind[];

/**
 * The sessions the loop monitor fails on a silent heartbeat (`zombie-session-reaper.ts:reapZombieSessions`):
 * a pipeline step's or an escalation's. The run standing's heartbeat clock asks the
 * same, so it promises a reap only where one happens.
 */
export function heartbeatReapedSql(session: SQL): SQL {
  return sql`(${session}.kind IN ${kindTuple(PIPELINE_SESSION_KINDS)}
    OR ${session}.metadata -> 'escalation' IS NOT NULL)`;
}

/**
 * The beat the heartbeat reaper measures a running session's silence from: its last heartbeat,
 * else the later of its start and its last update, else the later of its update and creation.
 * The reaper's WHERE and the run standing's heartbeat clock both read this one expression.
 */
export function heartbeatBeatSql(session: SQL): SQL {
  return sql`COALESCE(${session}.last_heartbeat_at,
    CASE WHEN ${session}.started_at IS NOT NULL
      THEN GREATEST(${session}.started_at, ${session}.updated_at)
      ELSE GREATEST(${session}.updated_at, ${session}.created_at) END)`;
}
