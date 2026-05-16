import { z } from 'zod';
import { PIPELINE_STEPS, type StepToggleKey } from './registry.js';

export type { StepToggleKey };

/**
 * Step toggle — accepts the v0 boolean form AND the new object form that
 * carries a per-step runner override. The orchestrator's `isToggleEnabled`
 * already accepts both shapes, so v0 documents continue to parse without a
 * data migration. The object form is the canonical going-forward shape.
 *
 * `runner` is intentionally `string` (not a closed enum). The dispatcher
 * resolves the runner type against the project's registered `runners` rows
 * and the global runner-adapter registry — keeping it open here means new
 * adapter types auto-work without a schema change.
 *
 * `model` is opaque: it is passed through to the adapter, never validated
 * here. Models change too frequently to enumerate.
 */
export const stepToggleSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean(),
    runner: z.string().optional(),
    model: z.string().optional(),
  }),
]);

export type StepToggle = z.infer<typeof stepToggleSchema>;

/**
 * Authoritative list of step toggle keys exposed to projects. Derived from
 * `PIPELINE_STEPS` in `./registry.ts` so a new step is added in exactly one
 * place. `clarified` is human-gated and intentionally absent from the
 * registry — there is no orchestrator code path for it.
 *
 * Cast to the explicit tuple literal because Zod's `z.enum` requires a
 * `readonly [string, ...string[]]` shape that the wider `string[]` type of
 * `Array.map` doesn't satisfy.
 */
export const STEP_TOGGLE_KEYS = PIPELINE_STEPS.map((s) => s.toggle) as unknown as readonly [
  'autoTriage',
  'autoPlan',
  'autoCode',
  'autoReview',
  'autoTest',
  'autoFix',
  'autoRelease',
];

/**
 * Per-stage `{ enabled, mode }` config under `pipelineConfig.states`.
 * `enabled:false` skips dispatch for both auto + PM paths; `mode:'manual'`
 * skips the auto path and rejects PM dispatch with
 * `FORBIDDEN: STAGE_MANUAL_ONLY`. Human-triggered `/run-pipeline-step` still
 * works regardless — manual mode means "only a human can fire this stage".
 *
 * `tested`, `pass`, `staging`, `deploying` are listed here despite having no
 * skill in STATUS_TO_JOB_TYPE: the FE needs a toggle to opt-in to soft-skip
 * auto-transition via STAGE_FORWARD for projects whose flow doesn't use those
 * stages. With `enabled:true` (the default) an issue parks at them; flipping
 * `enabled:false` engages the chain.
 */
export const STAGE_NAMES = [
  'open',
  'confirmed',
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

// Both fields optional so PATCH `{ states: { developed: { enabled: false } } }`
// works without the caller having to re-send `mode`. The orchestrator reads
// each field defensively (=== false / === 'manual'), so undefined values fall
// through to the defaults documented in `defaultStatesConfig()`.
export const stageConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(['auto', 'manual']).optional(),
  })
  .passthrough();

export type StageConfig = z.infer<typeof stageConfigSchema>;

export const statesConfigSchema = z
  .partialRecord(z.enum(STAGE_NAMES), stageConfigSchema)
  .optional();

export type StatesConfig = z.infer<typeof statesConfigSchema>;

export function defaultStatesConfig(): Record<StageName, StageConfig> {
  return Object.fromEntries(
    STAGE_NAMES.map((s) => [s, { enabled: true, mode: 'auto' as const }]),
  ) as Record<StageName, StageConfig>;
}

/**
 * Full pipeline config document as stored under
 * `projects.agentConfig.pipelineConfig`. Flat shape, matching the live
 * orchestrator + sweeper readers.
 *
 * Unknown keys are silently dropped on parse (Zod default) — this is
 * deliberate so legacy Strapi-era keys (`autoClarify`, `pipelineSteps`,
 * `previewEnabled`, etc.) round-trip through the API without causing 400s
 * but are not surfaced as configurable controls.
 *
 * Step toggles are listed explicitly (rather than generated from
 * `STEP_TOGGLE_KEYS`) so Zod can infer each as optional in the resulting
 * type. Adding a new step requires editing the const tuple above AND
 * adding one row here — kept in lockstep by the test that asserts every
 * `STEP_TOGGLE_KEYS` entry has a schema field.
 */
export const pipelineConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    autoTriage: stepToggleSchema.optional(),
    autoPlan: stepToggleSchema.optional(),
    autoCode: stepToggleSchema.optional(),
    autoReview: stepToggleSchema.optional(),
    autoTest: stepToggleSchema.optional(),
    autoFix: stepToggleSchema.optional(),
    autoRelease: stepToggleSchema.optional(),
    // ISS-40 PR-E — Layer 3 (per-project) dispatcher cap. DISTINCT issue_ids
    // with running agent_sessions; sessions beyond the cap stay queued with
    // failure_reason='project_full'. Backfilled to 3 by migration 0044.
    maxConcurrentIssues: z.number().int().positive().max(50).optional(),
    // ISS-108 Phase 1 / ISS-110 Phase 3 — per-stage enable/mode toggle. When
    // `states[X].enabled === false`, the orchestrator auto-transitions past
    // `X` (soft-skip) rather than dispatching a job. Cycle/dead-end detection
    // runs at PATCH time.
    states: statesConfigSchema,
  });

export type PipelineConfig = z.infer<typeof pipelineConfigSchema>;

/**
 * Patch payload for `PATCH /pipeline-config`. Carries the `pipelineConfig`
 * fields plus a sibling `runnerFallback` so the route can write both with
 * a single atomic jsonb merge — avoiding the clobber race that would
 * otherwise occur if the FE saved `runnerFallback` via the wide-open
 * `PATCH /projects/:id` route concurrently with a `pipelineConfig` write.
 */
export const pipelineConfigPatchSchema = pipelineConfigSchema.extend({
  runnerFallback: z.array(z.string()).optional(),
});

export type PipelineConfigPatchInput = z.infer<typeof pipelineConfigPatchSchema>;

/**
 * Defaults surfaced by `GET /pipeline-config` when a project has no stored
 * document.
 */
export const PIPELINE_CONFIG_DEFAULTS: PipelineConfig = {
  enabled: false,
  states: defaultStatesConfig(),
};

/**
 * Merge a partial patch onto the stored document, returning a new object.
 * Used by the route handler so the on-disk jsonb sub-key carries forward
 * unchanged keys (including legacy keys we don't surface in the schema).
 */
export function mergePipelineConfig(
  current: Record<string, unknown> | null | undefined,
  patch: PipelineConfig,
): Record<string, unknown> {
  return { ...(current ?? {}), ...patch };
}
