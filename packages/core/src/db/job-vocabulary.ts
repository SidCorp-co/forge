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
