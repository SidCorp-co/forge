import type { JobType, RunnerType } from '../db/schema.js';

export const RUNNER_CAPABILITIES: Record<RunnerType, readonly JobType[]> = {
  'claude-code': ['drive', 'smoke', 'release_batch', 'onboarding'],
};
