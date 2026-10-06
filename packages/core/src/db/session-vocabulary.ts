import { FAILURE_CAUSES, type FailureCause } from '@forge/contracts/failure-causes';
import {
  AGENT_SESSION_STATUSES,
  TERMINAL_AGENT_SESSION_STATUSES,
} from '@forge/contracts/session-machine';
import { type SQL, sql } from 'drizzle-orm';

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

/**
 * A running session the heartbeat reaper fails at `cutoffIso`: a reaped kind, not awaiting input, its
 * beat older than the cutoff. The reaper's WHERE and the sweeper's alarm both read this, so the alarm
 * never names a session the reaper skips.
 */
export function heartbeatSilentSql(session: SQL, cutoffIso: string): SQL {
  return sql`(${session}.status = 'running'
    AND ${session}.runtime_state IS DISTINCT FROM 'awaiting_input'
    AND ${heartbeatBeatSql(session)} < ${cutoffIso}
    AND ${heartbeatReapedSql(session)})`;
}
