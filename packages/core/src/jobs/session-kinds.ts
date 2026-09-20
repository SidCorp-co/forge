/**
 * Which species of session a query is asking about.
 *
 * This file used to hold three raw SQL tuples, because the species lived in a
 * jsonb key and a tuple was the only way to ask for it. It is a column now
 * (`agent_sessions.kind`), so the sets below are values and the SQL is built
 * from them — one place to add a sixth species, and no tuple that can drift
 * from the column's own vocabulary.
 */

import { sql } from 'drizzle-orm';
import { type AgentSessionKind, agentSessionKinds } from '../db/schema.js';

/** What `agent_sessions.kind` a box's resident dispatcher carries. */
export const MASTER_SESSION_KIND: AgentSessionKind = 'master';

/** What `agent_sessions.kind` one dispatch of work on a box carries. */
export const RUN_SESSION_KIND: AgentSessionKind = 'run_session';

/** Job-driven sessions: the ones a pipeline sweep is about. */
export const PIPELINE_SESSION_KINDS = ['pipeline', 'pm'] as const satisfies readonly AgentSessionKind[];

/** Everything that is NOT a person's conversation — the sweeps' "not a client" arm. */
export const NON_CLIENT_SESSION_KINDS = [
  'pipeline',
  'pm',
  'master',
  'run_session',
] as const satisfies readonly AgentSessionKind[];

/** A master answers to nobody's park deadline; it is the thing that parks. */
export const NEVER_PARKED_SESSION_KINDS = ['master'] as const satisfies readonly AgentSessionKind[];

/** The complement of {@link NON_CLIENT_SESSION_KINDS}, named rather than negated. */
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

/** Every kind, in one string, for a refusal that has to name what is valid. */
export const AGENT_SESSION_KIND_LIST = agentSessionKinds.join(', ');
