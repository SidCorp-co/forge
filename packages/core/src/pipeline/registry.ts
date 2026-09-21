import type { IssueStatus, JobType, RunnerType } from '../db/schema.js';
import { transitions } from './state-machine.js';

export const PIPELINE_REGISTRY_VERSION = 7;

export const RUNNER_CAPABILITIES: Record<RunnerType, readonly JobType[]> = {
  'claude-code': ['drive', 'smoke', 'release_batch', 'reconcile', 'verify_skill'],
};

export interface PipelineRegistryPayload {
  version: number;
  runnerCapabilities: Record<RunnerType, readonly JobType[]>;
  statusExits: Record<IssueStatus, readonly IssueStatus[]>;
}

export function getPipelineRegistry(): PipelineRegistryPayload {
  return {
    version: PIPELINE_REGISTRY_VERSION,
    runnerCapabilities: RUNNER_CAPABILITIES,
    statusExits: transitions,
  };
}
