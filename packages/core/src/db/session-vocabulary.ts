import { FAILURE_CAUSES, type FailureCause } from '../pipeline/failure-causes.js';

export const agentSessionKinds = ['master', 'run_session', 'pipeline', 'pm', 'chat'] as const;

export type AgentSessionKind = (typeof agentSessionKinds)[number];

// ISS-197 — `completed_via_recovery` / `cancelled_stale` are non-failure
// terminal markers written by the recovery-by-verification path in
// `jobs/retry.ts`. UI filters / analytics that partition on
// agent_sessions.status treat them as success states, not failures.
export const agentSessionStatuses = [
  'idle',
  'queued',
  'running',
  'completed',
  'failed',
  'completed_via_recovery',
  'cancelled_stale',
  'cancelled',
] as const;
export type AgentSessionStatus = (typeof agentSessionStatuses)[number];

export const terminalAgentSessionStatuses = [
  'completed',
  'failed',
  'completed_via_recovery',
  'cancelled_stale',
  'cancelled',
] as const satisfies readonly AgentSessionStatus[];

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
