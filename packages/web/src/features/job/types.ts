export type { Job, JobEvent } from '@forge/contracts';

/**
 * Mirror of `jobTypes` in `packages/core/src/db/schema.ts`. Kept as a literal
 * union so the web UI can narrow on creation without round-tripping through
 * the server.
 */
export type JobType =
  | 'claude-run'
  | 'triage'
  | 'clarify'
  | 'plan'
  | 'code'
  | 'review'
  | 'test'
  | 'fix'
  | 'staging'
  | 'release';

export type ModelTier = 'fast' | 'smart' | 'deep';

/**
 * Row shape returned by `GET /api/issues/:id/job-history?step=<type>`.
 * Backend roll-up of `usage_records` is via the
 * `usage_records.session_id::uuid = jobs.id` cast — queued/unstarted jobs
 * still appear with `tokens: 0`, `cost: 0`, `startedAt: null`.
 */
export interface JobHistoryRow {
  jobId: string;
  status: string;
  model: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  estTokens: number | null;
  tokens: number;
  cost: number;
}
