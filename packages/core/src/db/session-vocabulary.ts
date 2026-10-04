import { FAILURE_CAUSES, type FailureCause } from '@forge/contracts/failure-causes';
import {
  AGENT_SESSION_STATUSES,
  TERMINAL_AGENT_SESSION_STATUSES,
} from '@forge/contracts/session-machine';

export const agentSessionKinds = ['master', 'run_session', 'pipeline', 'pm', 'chat'] as const;

export type AgentSessionKind = (typeof agentSessionKinds)[number];

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
