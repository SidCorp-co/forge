/**
 * Pipeline Orchestrator
 *
 * Maps issue status transitions to pipeline skills and executes them.
 * Two execution modes per step:
 *   - "desktop" (default) — creates agent session, sends to desktop device via WebSocket
 *   - "antigravity" — sends prompt to Antigravity service for server-side execution
 */

export { STEP_TOGGLES } from './config';
export { dispatchNextForProject, promoteQueuedSession } from './dispatch';
export { onSessionComplete, onStatusChange } from './lifecycle';
export { retryPipelineStep } from './retry';

// Re-export for bootstrap usage
export { cleanupStaleSessions } from '../pipeline-utils';
