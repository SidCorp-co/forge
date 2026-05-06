import { z } from 'zod';
import { DEFAULT_RECOVERY_CONFIG } from './recovery-policy.js';

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
 * Per-failure-kind retry budgets. Each axis is independently optional so a
 * partial document like `{ transient: 10 }` overrides only `transient` and
 * inherits the other two from `DEFAULT_RECOVERY_CONFIG`.
 */
export const recoveryByKindSchema = z.object({
  transient: z.number().int().min(0).optional(),
  permanent: z.number().int().min(0).optional(),
  unknown: z.number().int().min(0).optional(),
});

export type RecoveryByKind = z.infer<typeof recoveryByKindSchema>;

/**
 * Recovery sub-keys read by the sweeper's `extractRecoveryConfig`. Names
 * mirror the live reader exactly — do NOT rename without a coordinated
 * migration of stored documents.
 *
 * - `recoveryMaxAttempts` — fallback cap when no per-kind override applies
 * - `recoveryWindowHours` — sliding window after which attempts auto-reset
 * - `recoveryByFailureKind` — per-kind caps; takes priority over max
 */
export const recoveryPolicySchema = z.object({
  recoveryMaxAttempts: z.number().int().min(0).max(20).optional(),
  recoveryWindowHours: z.number().positive().max(168).optional(),
  recoveryByFailureKind: recoveryByKindSchema.optional(),
});

export type RecoveryPolicy = z.infer<typeof recoveryPolicySchema>;

/**
 * Authoritative list of step toggle keys exposed to projects. Mirrors
 * `STATUS_TO_SKILL` in `skill-mapping.ts`. `clarified` is human-gated and
 * intentionally absent — there is no orchestrator code path for it.
 *
 * The const tuple drives both the schema and the type so a new step is
 * added in exactly one place.
 */
export const STEP_TOGGLE_KEYS = [
  'autoTriage',
  'autoPlan',
  'autoCode',
  'autoReview',
  'autoTest',
  'autoFix',
  'autoRelease',
] as const;

export type StepToggleKey = (typeof STEP_TOGGLE_KEYS)[number];

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
  })
  .merge(recoveryPolicySchema);

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
 * document. The recovery values mirror `DEFAULT_RECOVERY_CONFIG` so the UI
 * placeholder shows the same numbers the sweeper would actually use.
 */
export const PIPELINE_CONFIG_DEFAULTS: PipelineConfig = {
  enabled: false,
  recoveryMaxAttempts: DEFAULT_RECOVERY_CONFIG.maxAttempts,
  recoveryWindowHours: DEFAULT_RECOVERY_CONFIG.windowHours,
  recoveryByFailureKind: { ...DEFAULT_RECOVERY_CONFIG.byKind },
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
