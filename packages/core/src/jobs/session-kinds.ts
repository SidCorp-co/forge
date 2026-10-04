/**
 * Which species of session a query is asking about. `agent_sessions.kind` is
 * the column; these are the sets, and the SQL below is built from them.
 */
import { type SQL, sql } from 'drizzle-orm';
import { type AgentSessionKind, agentSessionKinds } from '../db/schema.js';
import {
  MASTER_SESSION_METADATA_TYPE,
  RUN_SESSION_METADATA_TYPE,
} from '../devices/run-session-keys.js';

export const MASTER_SESSION_KIND: AgentSessionKind = MASTER_SESSION_METADATA_TYPE;

export const RUN_SESSION_KIND: AgentSessionKind = RUN_SESSION_METADATA_TYPE;

export const PIPELINE_SESSION_KINDS = [
  'pipeline',
  'pm',
] as const satisfies readonly AgentSessionKind[];

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

export const CLIENT_SESSION_KINDS = ['chat'] as const satisfies readonly AgentSessionKind[];

/** A SQL `IN (...)` list over a set of kinds, parameterised. */
export function kindTuple(kinds: readonly AgentSessionKind[]) {
  return sql`(${sql.join(
    kinds.map((k) => sql`${k}`),
    sql`, `,
  )})`;
}

export function isAgentSessionKind(value: unknown): value is AgentSessionKind {
  return typeof value === 'string' && (agentSessionKinds as readonly string[]).includes(value);
}

export const AGENT_SESSION_KIND_LIST = agentSessionKinds.join(', ');

/**
 * The sessions the loop monitor fails on a silent heartbeat (`loop-monitor.ts:reapZombieSessions`):
 * a pipeline step's, an escalation's or an agent chat's. The run standing's heartbeat clock asks the
 * same, so it promises a reap only where one happens.
 */
export function heartbeatReapedSql(session: SQL): SQL {
  return sql`(${session}.kind IN ${kindTuple(PIPELINE_SESSION_KINDS)}
    OR ${session}.metadata -> 'escalation' IS NOT NULL
    OR ${session}.metadata -> 'agentChat' IS NOT NULL)`;
}
