// The browser's copies of the status answers `packages/core` owns. Neither package may import a
// runtime value from the other, so each constant below is a second declaration on purpose, and
// `packages/core/src/db/status-sets-parity.test.ts` is the whole of what keeps it identical to
// the answer core reads.

/* status-tuple: differs — the browser's copy of core's `jobs/status-sets.ts` LIVE_JOB_STATUSES,
   read by the pipeline activity feed; status-sets-parity.test.ts binds the two. */
export const LIVE_JOB_STATUSES = [
  'queued',
  'dispatched',
  'running',
  'held',
] as const;

/* status-tuple: differs — the browser's copy of core's `issues/status-sets.ts` NON_OPEN_STATUSES,
   read by the project dashboard's open-issue count; status-sets-parity.test.ts binds the two. */
export const NON_OPEN_ISSUE_STATUSES = [
  'awaiting_release',
  'closed',
  'draft',
] as const;

/* status-tuple: differs — the browser's copy of core's `issues/transition-reason.ts`
   REASON_REQUIRED_STATUSES, read by the transition dialog so the browser asks for the reason the
   server would refuse the move without; status-sets-parity.test.ts binds the two. */
export const REASON_REQUIRED_ISSUE_STATUSES = [
  'reopen',
  'waiting',
  'needs_info',
] as const;

/* status-tuple: differs — the browser's copy of core's `db/session-vocabulary.ts`
   terminalAgentSessionStatuses, read by the agent run-state derivation;
   status-sets-parity.test.ts binds the two. */
export const TERMINAL_AGENT_SESSION_STATUSES = [
  'completed',
  'failed',
  'completed_via_recovery',
  'cancelled_stale',
  'cancelled',
] as const;

/* status-tuple: differs — the browser's copy of core's `db/schema-memory-chunks.ts`
   memoryReindexStates, which is the `memory_reindex` jsonb's own vocabulary and not a session
   status, whatever its members coincide with; status-sets-parity.test.ts binds the two. */
export const MEMORY_REINDEX_STATES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;

export type MemoryReindexState = (typeof MEMORY_REINDEX_STATES)[number];
