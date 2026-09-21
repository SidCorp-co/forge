import type { PipelineRunStatus } from '../db/schema.js';

/** The run is over. No step of it will start, resume or be retried again. */
export const TERMINAL_PIPELINE_RUN_STATUSES: readonly PipelineRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
];
