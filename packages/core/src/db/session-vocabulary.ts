import { FAILURE_CAUSES, type FailureCause } from '@forge/contracts/failure-causes';
import {
  AGENT_SESSION_STATUSES,
  TERMINAL_AGENT_SESSION_STATUSES,
} from '@forge/contracts/session-machine';
import { sql } from 'drizzle-orm';

export const agentSessionKinds = ['master', 'run_session', 'pipeline', 'pm', 'chat'] as const;

export type AgentSessionKind = (typeof agentSessionKinds)[number];

export const RUN_ISSUES_METADATA_KEY = 'runIssues';
export const RUN_GROUP_METADATA_KEY = 'runGroup';
export const RUN_ISSUE_STATUSES_METADATA_KEY = 'runIssueStatuses';
export const RUN_SESSION_METADATA_TYPE = 'run_session';
export const MASTER_SESSION_METADATA_TYPE = 'master';

export const MASTER_SESSION_KIND: AgentSessionKind = MASTER_SESSION_METADATA_TYPE;

export const RUN_SESSION_KIND: AgentSessionKind = RUN_SESSION_METADATA_TYPE;

export const PIPELINE_SESSION_KINDS = [
  'pipeline',
  'pm',
] as const satisfies readonly AgentSessionKind[];

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
