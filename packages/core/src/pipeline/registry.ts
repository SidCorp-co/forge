// Pipeline SSOT. PIPELINE_STEPS is the only place the status × jobType ×
// toggle × skill mapping is written down. Other constants
// (STATUS_TO_JOB_TYPE, STATUS_TO_SKILL, STEP_TOGGLE_KEYS) derive from it;
// the HTTP endpoint at /api/pipeline/registry serializes the same payload.
//
// Cycle constraint: this file imports types from `../db/schema.js` only.
// It MUST NOT import from `@forge/contracts` (contracts → core is the
// established direction) and MUST NOT import values from
// `./pipeline-config-schema.js` — that would form a runtime cycle.

import type { IssueStatus, JobType, RunnerType } from '../db/schema.js';

export const PIPELINE_REGISTRY_VERSION = 1;

export const PIPELINE_STEPS = [
  { status: 'open', jobType: 'triage', toggle: 'autoTriage', skillName: 'forge-triage' },
  { status: 'confirmed', jobType: 'plan', toggle: 'autoPlan', skillName: 'forge-plan' },
  { status: 'approved', jobType: 'code', toggle: 'autoCode', skillName: 'forge-code' },
  { status: 'developed', jobType: 'review', toggle: 'autoReview', skillName: 'forge-review' },
  { status: 'testing', jobType: 'test', toggle: 'autoTest', skillName: 'forge-test' },
  { status: 'reopen', jobType: 'fix', toggle: 'autoFix', skillName: 'forge-fix' },
  { status: 'released', jobType: 'release', toggle: 'autoRelease', skillName: 'forge-release' },
] as const satisfies readonly {
  status: IssueStatus;
  jobType: JobType;
  toggle: string;
  skillName: string;
}[];

export type PipelineStep = (typeof PIPELINE_STEPS)[number];

// Derived from PIPELINE_STEPS so adding a step adds its toggle key
// automatically. `pipeline-config-schema.ts` re-exports this for the Zod
// enum tuple it needs.
export type StepToggleKey = PipelineStep['toggle'];

// Human-gated job types with no auto-dispatch path. Lives here so the FE
// can render the manual-only stages without hard-coding the list.
export const MANUAL_ONLY_JOB_TYPES: readonly JobType[] = ['clarify'];

// Mirrors the static map historically duplicated in
// `packages/web/src/features/pipeline/runner-capabilities.ts`. The web copy
// stays in place until a follow-up issue switches the FE to fetch the
// registry; the test suite asserts the values match.
export const RUNNER_CAPABILITIES: Record<RunnerType, readonly JobType[]> = {
  'claude-code': ['plan', 'code', 'review', 'fix', 'triage', 'test'],
  antigravity: ['plan', 'code', 'review', 'fix', 'triage', 'test', 'release'],
};

export interface JobTypeMapping {
  type: JobType;
  toggle: StepToggleKey;
}

export const STATUS_TO_JOB_TYPE: Partial<Record<IssueStatus, JobTypeMapping>> =
  Object.fromEntries(
    PIPELINE_STEPS.map((s) => [s.status, { type: s.jobType, toggle: s.toggle }]),
  ) as Partial<Record<IssueStatus, JobTypeMapping>>;

export const STATUS_TO_SKILL: Partial<Record<IssueStatus, string>> = Object.fromEntries(
  PIPELINE_STEPS.map((s) => [s.status, s.skillName]),
) as Partial<Record<IssueStatus, string>>;

export interface PipelineRegistryPayload {
  version: number;
  steps: readonly PipelineStep[];
  runnerCapabilities: Record<RunnerType, readonly JobType[]>;
  manualOnlyJobTypes: readonly JobType[];
}

export function getPipelineRegistry(): PipelineRegistryPayload {
  return {
    version: PIPELINE_REGISTRY_VERSION,
    steps: PIPELINE_STEPS,
    runnerCapabilities: RUNNER_CAPABILITIES,
    manualOnlyJobTypes: MANUAL_ONLY_JOB_TYPES,
  };
}
