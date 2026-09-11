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

// cm:guard TypeScript checks the KEYS of this Record, never the array contents, so a job type missing from a list compiles and then fails every dispatch permanently with `runner_unsupported_type`. `drive` shipped that way and burned two jobs on KineTrak (2026-08-20); registry.test.ts now asserts the membership the compiler cannot.
// cm:guard the nine staged types (`triage` `clarify` `plan` `code` `review` `test` `staging` `fix` `release`) were removed here by ISS-895 and must not come back. They survive in `jobTypes` because ~30k historical `jobs` rows hold them and a read of one must stay representable; being ABSENT here is what makes them unenqueueable — a runner handed one now fails it `runner_unsupported_type`, which is the loud refusal, not a regression.
// cm:why release_batch is dispatched explicitly via the batch-release REST endpoint, and reconcile / verify_skill by the reconcile service — none has a trigger status, and all three still need an entry here or the dispatcher fails them runner_unsupported_type.
export const RUNNER_CAPABILITIES: Record<RunnerType, readonly JobType[]> = {
  'claude-code': ['drive', 'smoke', 'release_batch', 'reconcile', 'verify_skill'],
};

export interface PipelineRegistryPayload {
  version: number;
  runnerCapabilities: Record<RunnerType, readonly JobType[]>;
  statusExits: Record<IssueStatus, readonly IssueStatus[]>;
}

// cm:guard serve `transitions` WHOLE and in its declared order — the status picker in web-v2 renders a row in the order it arrives and treats the first entry as the forward rung, so a sort or a filter here is a menu that puts the common move somewhere else (ISS-982)
// cm:edge contract -> packages/web-v2/src/features/issues/derive.ts#allowedTransitions — this endpoint is the ONLY way that table reaches the UI: core must not import @forge/contracts (guard above) and contracts already depends on core, so neither package can hold it for both sides. A second copy in web is the defect ISS-982 removed.
export function getPipelineRegistry(): PipelineRegistryPayload {
  return {
    version: PIPELINE_REGISTRY_VERSION,
    runnerCapabilities: RUNNER_CAPABILITIES,
    statusExits: transitions,
  };
}
