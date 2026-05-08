// Mirrors `SUPPORTED_TYPES` in `packages/dev/src/hooks/use-job-handler.ts`.
// Replace with a core-served capability list when one exists.
import type { JobType } from '@/features/job/types';

type RunnerType = 'claude-code' | 'antigravity';

export const RUNNER_CAPABILITIES: Record<RunnerType, readonly JobType[]> = {
  'claude-code': ['plan', 'code', 'review', 'fix', 'triage'],
  antigravity: ['plan', 'code', 'review', 'fix', 'triage', 'test', 'release'],
};

export function runnerSupports(runner: string | undefined, jobType: string): boolean {
  if (!runner) return true;
  const caps = RUNNER_CAPABILITIES[runner as RunnerType];
  if (!caps) return true;
  return caps.includes(jobType as JobType);
}
