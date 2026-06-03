/**
 * Frontend mirror of `PipelineConfig` from
 * `packages/core/src/pipeline/pipeline-config-schema.ts`. Keep in sync with
 * the backend Zod schema — when the schema gains a field there, add it
 * here too.
 */

export interface StepToggleObject {
  enabled: boolean;
  /** Runner adapter type. Strings, not a closed enum, so new adapters auto-work. */
  runner?: string;
  /** Opaque, passed through to the adapter. */
  model?: string;
}

export type StepToggleValue = boolean | StepToggleObject;

export interface RecoveryByKind {
  transient?: number;
  permanent?: number;
  unknown?: number;
}

export const STAGE_NAMES = [
  'open',
  'confirmed',
  'clarified',
  'approved',
  'developed',
  'testing',
  'tested',
  'pass',
  'staging',
  'deploying',
  'reopen',
  'released',
] as const;

export type StageName = (typeof STAGE_NAMES)[number];

export interface StageConfig {
  enabled?: boolean;
  mode?: 'auto' | 'manual';
}

export type StatesConfig = Partial<Record<StageName, StageConfig>>;

export interface PipelineConfig {
  enabled?: boolean;
  autoTriage?: StepToggleValue;
  autoClarify?: StepToggleValue;
  autoPlan?: StepToggleValue;
  autoCode?: StepToggleValue;
  autoReview?: StepToggleValue;
  autoTest?: StepToggleValue;
  autoFix?: StepToggleValue;
  autoRelease?: StepToggleValue;
  recoveryMaxAttempts?: number;
  recoveryWindowHours?: number;
  recoveryByFailureKind?: RecoveryByKind;
  states?: StatesConfig;
}

// ISS-232 Phase 3 — the sibling `runnerFallback` field was dropped from
// the patch shape (the deterministic v2 selector picks primary → standby
// with no project-wide type-chain). Per-stage `runner` overrides on step
// toggles continue to work via `StepToggleObject.runner`.
export type PipelineConfigPatch = Partial<PipelineConfig>;

export function defaultStageConfig(): StageConfig {
  return { enabled: true, mode: 'auto' };
}

export interface PipelineConfigResponse {
  pipelineConfig: PipelineConfig;
}

/** Helpers for working with the union step toggle type. */
export function isStepEnabled(v: StepToggleValue | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === 'boolean') return v;
  return v.enabled !== false;
}

export function getStepRunner(v: StepToggleValue | undefined): string | undefined {
  if (typeof v === 'object' && v !== null) return v.runner;
  return undefined;
}

export function getStepModel(v: StepToggleValue | undefined): string | undefined {
  if (typeof v === 'object' && v !== null) return v.model;
  return undefined;
}

/**
 * Build a step toggle value from the form state. Collapses to a boolean
 * when there is no per-step runner override (keeps the on-disk document
 * tidy and matches v0 storage shape).
 */
export function buildStepToggle(
  enabled: boolean,
  runner?: string,
  model?: string,
): StepToggleValue {
  if (!runner && !model) return enabled;
  const obj: StepToggleObject = { enabled };
  if (runner) obj.runner = runner;
  if (model) obj.model = model;
  return obj;
}
