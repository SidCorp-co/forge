// Mirror of `RUNNER_CAPABILITIES` in `packages/core/src/jobs/dispatch-gates.ts`.
// The server is SSOT and enforces the gate permanently at dispatch time;
// this client copy only powers per-stage UI affordances.
import type { JobType } from '@/features/job/types';

type RunnerType = 'claude-code' | 'antigravity';

export const RUNNER_CAPABILITIES: Record<RunnerType, readonly JobType[]> = {
  'claude-code': ['plan', 'code', 'review', 'fix', 'triage', 'test'],
  antigravity: ['plan', 'code', 'review', 'fix', 'triage', 'test', 'release'],
};

export function runnerSupports(runner: string | undefined, jobType: string): boolean {
  if (!runner) return true;
  const caps = RUNNER_CAPABILITIES[runner as RunnerType];
  if (!caps) return true;
  return caps.includes(jobType as JobType);
}
