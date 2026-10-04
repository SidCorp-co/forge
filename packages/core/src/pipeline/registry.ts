import { ISSUE_MACHINE, ISSUE_STATUSES, type IssueStatus } from '@forge/contracts/issue-machine';
import type { JobType, RunnerType } from '../db/schema.js';

export const PIPELINE_REGISTRY_VERSION = 8;

export const RUNNER_CAPABILITIES: Record<RunnerType, readonly JobType[]> = {
  'claude-code': ['drive', 'smoke', 'release_batch', 'onboarding'],
};

export interface PipelineRegistryPayload {
  version: number;
  runnerCapabilities: Record<RunnerType, readonly JobType[]>;
  /** Each status's lifecycle exits as the issue machine draws them; a park's return to the status
   *  it left is decided by that status, and is not listed. */
  statusExits: Record<IssueStatus, readonly IssueStatus[]>;
}

export function getPipelineRegistry(): PipelineRegistryPayload {
  return {
    version: PIPELINE_REGISTRY_VERSION,
    runnerCapabilities: RUNNER_CAPABILITIES,
    statusExits: Object.fromEntries(
      ISSUE_STATUSES.map((s) => [
        s,
        [
          ...new Set(
            ISSUE_MACHINE.edges
              .filter((e) => e.from === s && !e.recovery && !e.guards.includes('left_status'))
              .map((e) => e.to),
          ),
        ],
      ]),
    ) as Record<IssueStatus, IssueStatus[]>,
  };
}
