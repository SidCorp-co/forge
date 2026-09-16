// Pipeline SSOT for the one lane this pipeline has.
//
// Until ISS-895 this file held `PIPELINE_STEPS`: a nine-rung status × jobType ×
// toggle × skill table, plus six maps derived from it. That table WAS the
// staged lane. ISS-897 stripped the toggles that gated it and collapsed the
// orchestrator onto `dispatchAutonomous`; ISS-895 removed the table itself,
// the eight skill bodies it named, and every reader that resolved a step
// through it. What is left is the runner capability map, which is about job
// types a runner may be handed — not about a walk between statuses. Beside it
// now travels `statusExits`, which IS that walk: `state-machine.ts`'s table,
// served so the UI can offer a rung's real exits instead of the whole enum.
//
// Cycle constraint: this file imports from `../db/schema.js` and from
// `./state-machine.js`, which itself imports only the schema. It MUST NOT
// import from `@forge/contracts` (contracts → core is the established
// direction) and MUST NOT import values from `./pipeline-config-schema.js` —
// that would form a runtime cycle.

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
