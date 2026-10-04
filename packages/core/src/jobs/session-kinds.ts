/**
 * Which species of session a query is asking about. `agent_sessions.kind` is
 * the column; these are the sets, and the SQL below is built from them.
 */
import { type SQL, sql } from 'drizzle-orm';
import { type AgentSessionKind, agentSessionKinds } from '../db/schema.js';
import { kindTuple, PIPELINE_SESSION_KINDS } from '../db/session-vocabulary.js';

export {
  CLIENT_SESSION_KINDS,
  kindTuple,
  PIPELINE_SESSION_KINDS,
} from '../db/session-vocabulary.js';

/** Whether a row's own `kind` is one a pipeline step drives, so `/retry` may reach it. */
export function isPipelineSessionKind(kind: AgentSessionKind): boolean {
  return (PIPELINE_SESSION_KINDS as readonly AgentSessionKind[]).includes(kind);
}

export const NON_CLIENT_SESSION_KINDS = [
  'pipeline',
  'pm',
  'master',
  'run_session',
] as const satisfies readonly AgentSessionKind[];

export const NEVER_PARKED_SESSION_KINDS = ['master'] as const satisfies readonly AgentSessionKind[];

export function isAgentSessionKind(value: unknown): value is AgentSessionKind {
  return typeof value === 'string' && (agentSessionKinds as readonly string[]).includes(value);
}

export const AGENT_SESSION_KIND_LIST = agentSessionKinds.join(', ');

/**
 * The sessions the loop monitor fails on a silent heartbeat (`loop-monitor.ts:reapZombieSessions`):
 * a pipeline step's or an escalation's. The run standing's heartbeat clock asks the
 * same, so it promises a reap only where one happens.
 */
export function heartbeatReapedSql(session: SQL): SQL {
  return sql`(${session}.kind IN ${kindTuple(PIPELINE_SESSION_KINDS)}
    OR ${session}.metadata -> 'escalation' IS NOT NULL)`;
}
