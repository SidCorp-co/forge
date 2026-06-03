/**
 * Single source of truth for pipeline steps surfaced in the settings UI.
 * Mirrors `STATUS_TO_JOB_TYPE` in `packages/core/src/pipeline/skill-mapping.ts`.
 *
 * Adding a new step:
 *   1. Add the entry to STATUS_TO_JOB_TYPE in core.
 *   2. Add the toggle key to STEP_TOGGLE_KEYS in pipeline-config-schema.ts.
 *   3. Add a corresponding optional field in pipelineConfigSchema.
 *   4. Add the entry below.
 */

export interface StepDefinition {
  /** Pipeline-config key, e.g. 'autoTriage' */
  toggleKey:
    | 'autoTriage'
    | 'autoClarify'
    | 'autoPlan'
    | 'autoCode'
    | 'autoReview'
    | 'autoTest'
    | 'autoFix'
    | 'autoRelease';
  /** Human label for the row */
  label: string;
  /** One-sentence description shown under the label */
  description: string;
  /** Status transition this step performs — display only */
  statusTransition: string;
  /** JobType string (cross-references core skill-mapping) */
  jobType: string;
}

export const STEP_REGISTRY: readonly StepDefinition[] = [
  {
    toggleKey: 'autoTriage',
    label: 'Triage',
    description: 'Validates completeness, classifies complexity, sets category and priority.',
    statusTransition: 'open → confirmed',
    jobType: 'triage',
  },
  {
    toggleKey: 'autoClarify',
    label: 'Clarify',
    description: 'Reproduces bugs / validates UX in a live env before planning, captures evidence.',
    statusTransition: 'confirmed → clarified',
    jobType: 'clarify',
  },
  {
    toggleKey: 'autoPlan',
    label: 'Plan',
    description: 'Explores codebase, writes implementation plan with QA scenarios.',
    statusTransition: 'clarified → approved',
    jobType: 'plan',
  },
  {
    toggleKey: 'autoCode',
    label: 'Code',
    description: 'Implements from plan, builds, runs tiered review, commits and pushes.',
    statusTransition: 'approved → developed',
    jobType: 'code',
  },
  {
    toggleKey: 'autoReview',
    label: 'Review',
    description: 'Independent code review with fresh context.',
    statusTransition: 'developed → deploying / reopen',
    jobType: 'review',
  },
  {
    toggleKey: 'autoTest',
    label: 'QA Test',
    description: 'Automated QA against the staging environment.',
    statusTransition: 'testing → staging',
    jobType: 'test',
  },
  {
    toggleKey: 'autoFix',
    label: 'Fix',
    description: 'Reads rejection feedback, applies a scoped fix on the ISS-* branch.',
    statusTransition: 'reopen → developed',
    jobType: 'fix',
  },
  {
    toggleKey: 'autoRelease',
    label: 'Release',
    description: 'Squash-merges ISS-* to productionBranch and triggers Coolify deploy.',
    statusTransition: 'released → closed',
    jobType: 'release',
  },
] as const;

export type StepToggleKey = StepDefinition['toggleKey'];
