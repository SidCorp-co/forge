/**
 * Dream Memory Consolidation Service
 *
 * Mines agent comments and pipeline activity to consolidate memories:
 * - Gathers recent signal (comments, status changes, reopen cycles)
 * - Sends to LLM with existing memories for consolidation
 * - Executes create/update/promote/prune actions
 * - Logs summary as project activity
 */

export type { DreamSignal, DreamActions, DreamResult } from './types';
export { gatherDreamSignal } from './signal';
export { runDreamConsolidation } from './consolidation';
export { startDreamPoller } from './poller';
