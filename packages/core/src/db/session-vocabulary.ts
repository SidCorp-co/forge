import { FAILURE_CAUSES, type FailureCause } from '@forge/contracts/failure-causes';
import {
  AGENT_SESSION_STATUSES,
  TERMINAL_AGENT_SESSION_STATUSES,
} from '@forge/contracts/session-machine';
import { sql } from 'drizzle-orm';

export const agentSessionKinds = ['master', 'run_session', 'pipeline', 'chat'] as const;

export type AgentSessionKind = (typeof agentSessionKinds)[number];

export const PIPELINE_SESSION_KINDS = ['pipeline'] as const satisfies readonly AgentSessionKind[];

export const CLIENT_SESSION_KINDS = ['chat'] as const satisfies readonly AgentSessionKind[];

/** A SQL `IN (...)` list over a set of kinds, parameterised. */
export function kindTuple(kinds: readonly AgentSessionKind[]) {
  return sql`(${sql.join(
    kinds.map((k) => sql`${k}`),
    sql`, `,
  )})`;
}

export const agentSessionStatuses = AGENT_SESSION_STATUSES;
export type AgentSessionStatus = (typeof agentSessionStatuses)[number];

export const terminalAgentSessionStatuses = TERMINAL_AGENT_SESSION_STATUSES;

export const sessionRuntimeStates = [
  'starting',
  'working',
  'awaiting_input',
  'checkpointing',
  'closed',
] as const;
export type SessionRuntimeState = (typeof sessionRuntimeStates)[number];

export const agentSessionFailureReasons = FAILURE_CAUSES;
export type AgentSessionFailureReason = FailureCause;
