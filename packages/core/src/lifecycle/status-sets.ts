import type { AgentSessionStatus } from '../db/schema.js';

/**
 * The named answers about `agentSessionStatuses`. One question has one answer:
 * a caller asks by importing the name, never by writing the tuple again.
 *
 * They live beside `transition.ts` because `applyKernelTransition` is the one
 * writer of `agent_sessions.status`, and the module that writes a vocabulary is
 * the module every reader of it already depends on.
 */

/** The session is still the runner's: it is working, waiting to work, or between turns. */
export const LIVE_SESSION_STATUSES: readonly AgentSessionStatus[] = ['queued', 'running', 'idle'];

// cm:why a run none of whose sessions completed or failed was stopped, so it closes `cancelled`:
// read as `failed` it counted a person's cancel as a failure, and as `completed` as work done (ISS-100).
export function oneShotRunOutcome(read: {
  anyCompleted: boolean;
  anyFailed: boolean;
}): 'completed' | 'failed' | 'cancelled' {
  if (read.anyFailed) return 'failed';
  return read.anyCompleted ? 'completed' : 'cancelled';
}
