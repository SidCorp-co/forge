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
