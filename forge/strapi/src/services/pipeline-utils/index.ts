/**
 * Pipeline Utilities
 *
 * Shared helpers for pipeline orchestration: session queries, comments, cleanup.
 */

// Constants & telemetry
export {
  SESSION_UID,
  pipelineTelemetry,
  MAX_REOPEN_CYCLES,
  DONE_ENOUGH_STATUSES,
  DECOMP_CHILD_READY_STATUSES,
  MAX_SESSION_RETRIES,
  MAX_FRESH_RETRIES,
  MAX_RESUMABLE_CONTEXT,
} from './constants';

// Error classification & device management
export {
  isUsageLimitError,
  isTransientOverloadError,
  isApiServerError,
  API_SERVER_ERROR_DISABLE_MS,
  parseUsageLimitReset,
  disableDeviceUntil,
  handleUsageLimitIfPresent,
} from './error-classification';

// Session queries
export {
  checkDependenciesResolved,
  findResumableSession,
  countFailedFreshSessions,
  findRunningSessionForIssue,
  findRunningSessionForProject,
  countReopenCycles,
  hasRunningSessionForIssue,
} from './session-queries';

// Comments
export { postPipelineComment } from './comments';

// Session lifecycle & recovery
export {
  cleanupStaleSessions,
  updateSessionFailed,
  recoverOrFailSession,
  startStaleSessionWatcher,
} from './session-lifecycle';

// Pipeline control
export {
  loadPipelineControlState,
  isPipelinePaused,
  setPipelinePaused,
  getPipelineControlState,
  dispatchAllQueued,
  sleep,
} from './control';
