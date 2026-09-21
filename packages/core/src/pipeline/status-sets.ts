import type { PipelineRunStatus } from '../db/schema.js';

/** Whether a run is over: TERMINAL is nothing more will run, LIVE is a step runs or waits. */
export const TERMINAL_PIPELINE_RUN_STATUSES: readonly PipelineRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

export const LIVE_PIPELINE_RUN_STATUSES: readonly PipelineRunStatus[] = ['running', 'paused'];
