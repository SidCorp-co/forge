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
 * place. Includes `autoClarify` (ISS-171) for the `needs_info → clarify`
 * auto-dispatch path; the legacy `clarified` status was never reified — the
 * stage status is `needs_info`.
 *
 * Cast to the explicit tuple literal because Zod's `z.enum` requires a
 * `readonly [string, ...string[]]` shape that the wider `string[]` type of
 * `Array.map` doesn't satisfy.
 */
export const STEP_TOGGLE_KEYS = PIPELINE_STEPS.map((s) => s.toggle) as unknown as readonly [
  'autoTriage',
  'autoClarify',
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
  'needs_info',
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

/**
 * Per-state system prompt customization.
 * - `append`: extras appended after PIPELINE_RULES + TOOL_REFERENCE + project
 *   config (cache prefix still hits 5-min TTL — recommended default).
 * - `replace`: extras REPLACE the entire static prefix (operator owns the
 *   whole prompt; cache misses every job; UI surfaces a warning).
 */
export const systemPromptOverrideSchema = z
  .object({
    mode: z.enum(['append', 'replace']).optional(),
    extras: z.string().max(32_000).nullable().optional(),
  })
  .strict()
  .refine(
    (v) => {
      // `mode='replace'` with empty/null extras would silently degrade to
      // the static prefix — confusing the operator who explicitly set
      // 'replace' to override it. Force extras to be present when replacing.
      if (v.mode !== 'replace') return true;
      return typeof v.extras === 'string' && v.extras.trim().length > 0;
    },
    {
      message: 'systemPrompt.mode="replace" requires non-empty extras',
      path: ['extras'],
    },
  );

export type SystemPromptOverrideConfig = z.infer<typeof systemPromptOverrideSchema>;

/**
 * Per-state user-prompt policy override. Tunes which issue fields render in
 * the `## Issue` block, sessionContext depth/fields, truncation behavior,
 * and per-field caps. Server does NOT enforce a hard cap on `fieldCaps`
 * (per D3) — operator owns the token budget.
 */
export const userPromptPolicySchema = z
  .object({
    includeFields: z.array(z.enum(['description', 'plan', 'acceptanceCriteria'])).optional(),
    sessionContext: z
      .object({
        depth: z.int().nonnegative().max(50).optional(),
        fields: z
          .array(z.enum(['decisions', 'filesModified', 'errorsResolved', 'reviewFeedback']))
          .optional(),
      })
      .strict()
      .optional(),
    fieldCaps: z
      .object({
        description: z.int().positive().optional(),
        plan: z.int().positive().optional(),
        acceptanceCriteria: z.int().positive().optional(),
      })
      .strict()
      .optional(),
    truncationStrategy: z.enum(['paragraph-boundary', 'byte-cut']).optional(),
  })
  .strict();

export type UserPromptPolicyConfig = z.infer<typeof userPromptPolicySchema>;

/**
 * Per-state budget caps. Pre-dispatch monthly + per-run kill thresholds.
 *
 * `action` selects enforcement at the monthly cap (W2.3.2):
 *   - 'pause' (default when `perMonthUsd` is set): warn at 80%, hard-fail
 *     new dispatches at 100% with `failureReason='monthly_budget_exhausted'`.
 *   - 'warn'  : warn at 80% and 100% but never block dispatch.
 */
export const budgetConfigSchema = z
  .object({
    perRunUsd: z.number().positive().max(10_000).optional(),
    perMonthUsd: z.number().positive().max(1_000_000).optional(),
    action: z.enum(['warn', 'pause']).optional(),
  })
  .strict();

export type BudgetConfig = z.infer<typeof budgetConfigSchema>;

// Both `enabled` and `mode` are optional so PATCH
// `{ states: { developed: { enabled: false } } }` works without resending
// the rest. New per-state config fields (skillName, model, allowedTools,
// permissionMode, timeoutSeconds, mcpServers, systemPrompt, userPromptPolicy,
// budget, sessionGroup) are all optional; defaults preserve the
// current hardcoded behavior.
//
// No `.passthrough()` — the merge layer (`mergePipelineConfig`) handles
// legacy-key round-trip at the top level via spread. Stage-level legacy
// keys are not preserved by design; the schema is the source of truth for
// what a stage block may contain.
export const stageConfigSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['auto', 'manual']).optional(),
  // Skill + dispatch flags
  skillName: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(64).optional(),
  allowedTools: z.array(z.string().min(1).max(128)).max(100).nullable().optional(),
  permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
  timeoutSeconds: z.int().positive().max(86_400).optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  // Prompt content overrides — orchestrator + dispatcher resolve before stamping.
  systemPrompt: systemPromptOverrideSchema.optional(),
  userPromptPolicy: userPromptPolicySchema.optional(),
  // Budget caps (consumed by dispatcher pre-flight + in-flight kill paths).
  budget: budgetConfigSchema.optional(),
  // Session-group membership (PR-5). Joins this stage to a named group whose
  // members share a Claude CLI session via --resume across the group.
  sessionGroup: z.string().min(1).max(64).optional(),
});

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
 * deliberate so legacy Strapi-era keys (`clarified`, `pipelineSteps`,
 * `previewEnabled`, etc.) round-trip through the API without causing 400s
 * but are not surfaced as configurable controls.
 *
 * Step toggles are listed explicitly (rather than generated from
 * `STEP_TOGGLE_KEYS`) so Zod can infer each as optional in the resulting
 * type. Adding a new step requires editing the const tuple above AND
 * adding one row here — kept in lockstep by the test that asserts every
 * `STEP_TOGGLE_KEYS` entry has a schema field.
 */
/**
 * Session group: a named set of stages that share one Claude CLI session.
 * The first dispatched stage in a group creates the session; subsequent
 * stages resume via `--resume <claudeSessionId>`. Each stage still owns its
 * own system prompt, model, and tools (server stamps them every dispatch);
 * the runner falls back to embedding the state's system prompt as
 * turn-level rules in the user prompt body when CLI ignores
 * --append-system-prompt on resume (undocumented behavior).
 *
 * On resume failure (session file gone, version drift, CLI error), the
 * orchestrator re-dispatches per `onResumeFail`:
 *  - "fresh" (default): retry without claudeSessionId — fresh CLI session.
 *  - "abort": fail the job; operator must investigate.
 */
export const sessionGroupsSchema = z.record(
  z.string().min(1).max(64),
  z.array(z.enum(STAGE_NAMES)).min(1).max(STAGE_NAMES.length),
);

export type SessionGroupsConfig = z.infer<typeof sessionGroupsSchema>;

/**
 * ISS-232 — per-project mapping of which stage status represents a merge
 * event. The state-machine stamps `issues.merged_at` when an issue
 * transitions OUT of `baseBranch`; the picker's L2 dependency gate keys on
 * the resulting `merged_at IS NULL` predicate.
 *
 * Trunk-based projects (jarvis-agents, Anhome) leave both fields at
 * `"released"` — `productionBranch` collapses into `baseBranch` and the
 * `releaseDecomposePending` L2 gate shares the column with `blockedBy`.
 * Multi-base-branch projects will split these in a future v3 with a
 * dedicated `merged_to_prod_at` column.
 */
export const mergeStatesSchema = z
  .object({
    baseBranch: z.enum(STAGE_NAMES).optional(),
    productionBranch: z.enum(STAGE_NAMES).optional(),
  })
  .strict();

export type MergeStatesConfigInput = z.infer<typeof mergeStatesSchema>;

export const pipelineConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    autoTriage: stepToggleSchema.optional(),
    autoClarify: stepToggleSchema.optional(),
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
    // PR-5 — session-group routing.
    sessionGroups: sessionGroupsSchema.optional(),
    onResumeFail: z.enum(['fresh', 'abort']).optional(),
    // ISS-232 — git-aware L2 dependency gate config.
    mergeStates: mergeStatesSchema.optional(),
  })
  // PR-5 — cross-field validation: every `states[x].sessionGroup` must be a
  // declared group in `sessionGroups`. Without this, a typo
  // (`'implmentation'` vs `'implementation'`) passes Zod silently and the
  // orchestrator stamps a group name that `findPriorSessionInGroup` will
  // never match — operator sees fresh sessions instead of resume.
  .superRefine((cfg, ctx) => {
    if (!cfg.states || !cfg.sessionGroups) return;
    const declaredGroups = new Set(Object.keys(cfg.sessionGroups));
    for (const [stageName, stageCfg] of Object.entries(cfg.states)) {
      if (!stageCfg || typeof stageCfg !== 'object') continue;
      const sg = (stageCfg as { sessionGroup?: unknown }).sessionGroup;
      if (typeof sg === 'string' && sg.length > 0 && !declaredGroups.has(sg)) {
        ctx.addIssue({
          code: 'custom',
          path: ['states', stageName, 'sessionGroup'],
          message: `sessionGroup "${sg}" is not declared in pipelineConfig.sessionGroups`,
        });
      }
    }
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
