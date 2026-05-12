import type { JobType } from '@/features/job/types';

export type PipelineRunStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type PipelineRunKind = 'issue' | 'pm' | 'interactive' | 'system';

export type PipelineStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface PipelineRunStepSummary {
  jobType: JobType | string;
  status: PipelineStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  agentSessionId: string | null;
}

export interface PipelineRunCostSummary {
  estimatedCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requests: number;
  sampleCount: number;
}

export interface PipelineRun {
  id: string;
  projectId: string;
  issueId: string | null;
  kind: PipelineRunKind;
  status: PipelineRunStatus;
  currentStep: string | null;
  startedAt: string;
  finishedAt: string | null;
  steps: PipelineRunStepSummary[];
  cost: PipelineRunCostSummary;
}

export type PipelineRunListItem = Omit<PipelineRun, 'steps'>;

export const PIPELINE_RUN_STATUSES: PipelineRunStatus[] = [
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
];

export const PIPELINE_RUN_TERMINAL_STATUSES: PipelineRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

export function isTerminalRunStatus(status: PipelineRunStatus): boolean {
  return PIPELINE_RUN_TERMINAL_STATUSES.includes(status);
}
