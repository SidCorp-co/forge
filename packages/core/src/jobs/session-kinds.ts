/**
 * Which species of session a query is asking about. `agent_sessions.kind` is
 * the column; these are the sets, and the SQL below is built from them.
 */
import { sql } from 'drizzle-orm';
import { type AgentSessionKind, agentSessionKinds } from '../db/schema.js';

export const MASTER_SESSION_KIND: AgentSessionKind = 'master';

export const RUN_SESSION_KIND: AgentSessionKind = 'run_session';

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
