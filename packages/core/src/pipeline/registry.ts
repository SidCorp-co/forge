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

export const PIPELINE_REGISTRY_VERSION = 3;

// `workingStatus` — the in-flight status the step's agent flips the issue to
// when it BEGINS work (via `forge_step_start`), so the board shows in-flight
// progress without inventing new enum values. Sparse by design: only steps
// whose in-flight state already exists in `issueStatuses` get one; null means
// the trigger status doubles as the in-flight signal (short steps — visibility
// comes from `pipeline_runs.currentStep`). `test` stays null because its
// trigger `testing` IS the in-flight status already.
export const PIPELINE_STEPS = [
  {
    status: 'open',
    jobType: 'triage',
    toggle: 'autoTriage',
    skillName: 'forge-triage',
    workingStatus: null,
  },
  // Clarify-on-happy-path: clarify runs AFTER triage confirms the issue
  // (reproduce the bug / verify UX before planning) and exits to `clarified`,
  // where plan picks up. needs_info is a human-gated bounce state again — no
  // pipeline step dispatches there.
  {
    status: 'confirmed',
    jobType: 'clarify',
    toggle: 'autoClarify',
    skillName: 'forge-clarify',
    workingStatus: null,
  },
  {
    status: 'clarified',
    jobType: 'plan',
    toggle: 'autoPlan',
    skillName: 'forge-plan',
    workingStatus: null,
  },
  {
    status: 'approved',
    jobType: 'code',
    toggle: 'autoCode',
    skillName: 'forge-code',
    workingStatus: 'in_progress',
  },
  {
    status: 'developed',
    jobType: 'review',
    toggle: 'autoReview',
    skillName: 'forge-review',
    workingStatus: null,
  },
  {
    status: 'testing',
    jobType: 'test',
    toggle: 'autoTest',
    skillName: 'forge-test',
    workingStatus: null,
  },
  {
    status: 'reopen',
    jobType: 'fix',
    toggle: 'autoFix',
    skillName: 'forge-fix',
    workingStatus: 'in_progress',
  },
  {
    status: 'released',
    jobType: 'release',
    toggle: 'autoRelease',
    skillName: 'forge-release',
    workingStatus: null,
  },
] as const satisfies readonly {
  status: IssueStatus;
  jobType: JobType;
  toggle: string;
  skillName: string;
  workingStatus: IssueStatus | null;
}[];

export type PipelineStep = (typeof PIPELINE_STEPS)[number];

// Derived from PIPELINE_STEPS so adding a step adds its toggle key
// automatically. `pipeline-config-schema.ts` re-exports this for the Zod
// enum tuple it needs.
export type StepToggleKey = PipelineStep['toggle'];

// Human-gated job types with no auto-dispatch path. Empty since ISS-171
// promoted 'clarify' to a first-class step (now on the happy path at
// `confirmed`); kept exported because the FE renders this list.
export const MANUAL_ONLY_JOB_TYPES: readonly JobType[] = [];

// ISS-196 — statuses that auto-dispatch a job. Derived from PIPELINE_STEPS
// so adding a step here automatically expands the reconciler's rescue set.
export const AUTO_DISPATCH_STATUSES: readonly IssueStatus[] = PIPELINE_STEPS.map((s) => s.status);

// Mirrors the static map historically duplicated in
// `packages/web/src/features/pipeline/runner-capabilities.ts`. The web copy
// stays in place until a follow-up issue switches the FE to fetch the
// registry; the test suite asserts the values match.
export const RUNNER_CAPABILITIES: Record<RunnerType, readonly JobType[]> = {
  'claude-code': ['plan', 'code', 'review', 'fix', 'triage', 'test', 'release', 'clarify'],
  antigravity: ['plan', 'code', 'review', 'fix', 'triage', 'test', 'release', 'clarify'],
};

export interface JobTypeMapping {
  type: JobType;
  toggle: StepToggleKey;
}

export const STATUS_TO_JOB_TYPE: Partial<Record<IssueStatus, JobTypeMapping>> = Object.fromEntries(
  PIPELINE_STEPS.map((s) => [s.status, { type: s.jobType, toggle: s.toggle }]),
) as Partial<Record<IssueStatus, JobTypeMapping>>;

export const STATUS_TO_SKILL: Partial<Record<IssueStatus, string>> = Object.fromEntries(
  PIPELINE_STEPS.map((s) => [s.status, s.skillName]),
) as Partial<Record<IssueStatus, string>>;

/** Per-step in-flight status (sparse — see PIPELINE_STEPS.workingStatus). */
export const WORKING_STATUS_BY_JOB_TYPE: Partial<Record<JobType, IssueStatus>> = Object.fromEntries(
  PIPELINE_STEPS.filter((s) => s.workingStatus !== null).map((s) => [s.jobType, s.workingStatus]),
) as Partial<Record<JobType, IssueStatus>>;

/** Trigger status for a step (the status whose transition dispatches it). */
export const TRIGGER_STATUS_BY_JOB_TYPE: Partial<Record<JobType, IssueStatus>> = Object.fromEntries(
  PIPELINE_STEPS.map((s) => [s.jobType, s.status]),
) as Partial<Record<JobType, IssueStatus>>;

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
