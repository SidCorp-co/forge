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
 * The sessions the loop monitor fails on a silent heartbeat (`loop-monitor.ts:reapZombieSessions`):
 * a pipeline step's or an escalation's. The run standing's heartbeat clock asks the
 * same, so it promises a reap only where one happens.
 */
export function heartbeatReapedSql(session: SQL): SQL {
  return sql`(${session}.kind IN ${kindTuple(PIPELINE_SESSION_KINDS)}
    OR ${session}.metadata -> 'escalation' IS NOT NULL)`;
}
