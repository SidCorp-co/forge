export const jobStatuses = [
  'queued',
  'dispatched',
  'running',
  'held',
  'done',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const jobTypes = [
  'triage',
  'clarify',
  'plan',
  'code',
  'review',
  'test',
  'staging',
  'release',
  'fix',
  'custom',
  'pm',
  'smoke',
  'release_batch',
  'reconcile',
  'verify_skill',
  'drive',
] as const;
export type JobType = (typeof jobTypes)[number];

export const modelTiers = ['haiku', 'sonnet', 'opus'] as const;
export type ModelTier = (typeof modelTiers)[number];

export const pipelineRunKinds = ['issue', 'pm', 'interactive', 'system'] as const;
export type PipelineRunKind = (typeof pipelineRunKinds)[number];

export const pipelineRunStatuses = [
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type PipelineRunStatus = (typeof pipelineRunStatuses)[number];
