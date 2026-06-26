import { z } from 'zod';
import { issueComplexities } from '../db/schema.js';
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
 * place. Includes `autoClarify` (ISS-171, re-homed to the happy path): the
 * `confirmed → clarify` auto-dispatch gate; clarify exits to the (now
 * reified) `clarified` status, where plan dispatches.
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
 * `tested` is listed here despite having no skill in STATUS_TO_JOB_TYPE: the FE
 * needs a toggle to opt-in to soft-skip auto-transition via STAGE_FORWARD. With
 * `mode:'manual'` (the default) an issue parks at it; `enabled:false` skips it.
 * `pass`/`staging`/`deploying` were retired (unify gate model) — `tested`
 * ("Awaiting release") is the single production approval gate, and review exits
 * straight to `testing`.
 */
export const STAGE_NAMES = [
  'open',
  'needs_info',
  'confirmed',
  'clarified',
  'approved',
  'developed',
  'testing',
  'tested',
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
    /**
     * Step-handoff memory injection + verification (proposal Y).
     *
     * When `enabled=true` the prompt builder:
     *   - Queries `memories` for prior step handoffs scoped to the current
     *     pipeline_run and renders them under `## Prior step handoffs`.
     *   - Skips raw `description` / `plan` injection for steps whose
     *     handoff is present (saves prompt tokens).
     *   - Appends a `## Termination protocol` block instructing the agent
     *     to call `forge_memory.write` with the rendered schema and emit
     *     `DONE` only after the write succeeds.
     *
     * The lifecycle hook (`POST /api/jobs/:id/complete`) then verifies:
     *   - `requireHandoffWrite=true`  → look up the handoff row; fail the
     *     job with `failureKind='handoff_not_written'` if missing.
     *   - `missingMarkerPolicy`       → behaviour when the agent's last
     *     text does not end with `DONE`/`HANDOFF_GIVE_UP`:
     *       'fail'   — mark FAILED (`handoff_no_done_marker`)
     *       'warn'   — log breadcrumb, finalize as done (rollout-safe)
     *       'silent' — finalize as done, no log
     *
     * `fallbackToRawIssueFieldIfMissing=true` keeps the raw `description`/
     * `plan` injection when a predecessor handoff is missing — rollout-safe
     * during Phase 1a/b before every project has produced handoffs.
     */
    handoffs: z
      .object({
        enabled: z.boolean().default(false),
        injectFromSteps: z
          .array(
            z.enum(['triage', 'clarify', 'plan', 'code', 'review', 'test', 'stage', 'release', 'fix']),
          )
          .default([]),
        fallbackToRawIssueFieldIfMissing: z.boolean().default(true),
        requireHandoffWrite: z.boolean().default(true),
        missingMarkerPolicy: z.enum(['fail', 'warn', 'silent']).default('warn'),
      })
      .strict()
      .optional(),
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
// disallowedTools, permissionMode, timeoutSeconds, mcpServers, systemPrompt,
// userPromptPolicy,
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
  // Capability denylist (ISS-531). Forwarded to the runner as Claude Code's
  // `--disallowed-tools` (a real DENYLIST that removes a tool from the
  // available SET even under `--permission-mode bypassPermissions`, verified
  // on claude v2.1.185 — not just an auto-approval gate). Use for least-agency
  // hard-deny of high-agency tools per stage (e.g. forge_projects_archive,
  // forge_jobs_cancel, forge_memory_write). Independent of `allowedTools`;
  // when both are set the CLI applies allow then deny.
  disallowedTools: z.array(z.string().min(1).max(128)).max(100).nullable().optional(),
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
  // Complexity-based auto-skip. When the issue landing on this stage has a
  // `complexity` in this list, the soft-skip resolver treats the stage as
  // skippable (reason `complexity_skip`) instead of dispatching its job —
  // same chain/telemetry as disabled-stage and missing-skill skips. Primary
  // use: `states.confirmed.skipComplexities=['xs','s']` lets trivially-sized
  // issues bypass the clarify step. Unset = never skip.
  skipComplexities: z.array(z.enum(issueComplexities)).max(issueComplexities.length).optional(),
});

export type StageConfig = z.infer<typeof stageConfigSchema>;

export const statesConfigSchema = z
  .partialRecord(z.enum(STAGE_NAMES), stageConfigSchema)
  .optional();

export type StatesConfig = z.infer<typeof statesConfigSchema>;

/**
 * ISS-581 — stages that should NOT have access to scheduling/orchestration
 * agency tools by default. Review/test/release agents don't need to create
 * schedules, run workflows, or trigger remote jobs — denying these reduces the
 * blast radius if an agent behaves unexpectedly. allowedTools is intentionally
 * NOT set: an allowlist must enumerate every builtin and is fragile on CLI
 * upgrades, whereas a denylist is expansion-safe.
 */
const STAGE_DEFAULT_DISALLOWED: Partial<Record<StageName, string[]>> = {
  developed: ['CronCreate', 'CronDelete', 'CronList', 'Workflow', 'RemoteTrigger', 'ScheduleWakeup'],
  testing: ['CronCreate', 'CronDelete', 'CronList', 'Workflow', 'RemoteTrigger', 'ScheduleWakeup'],
  released: ['CronCreate', 'CronDelete', 'CronList', 'Workflow', 'RemoteTrigger', 'ScheduleWakeup'],
};

export function defaultStatesConfig(): Record<StageName, StageConfig> {
  return Object.fromEntries(
    STAGE_NAMES.map((s) => [
      s,
      // `tested` is the production approval GATE — `manual` by default so the
      // pipeline PARKS for a human before release. Flip to `auto` for full
      // auto-ship. Every other stage runs automatically.
      {
        enabled: true,
        mode: s === 'tested' ? ('manual' as const) : ('auto' as const),
        ...(STAGE_DEFAULT_DISALLOWED[s] ? { disallowedTools: STAGE_DEFAULT_DISALLOWED[s] } : {}),
      },
    ]),
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
 * `decomposeChildrenPending` L2 gate shares the column with `blockedBy`.
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
    // Per-project cap on simultaneously-active issues. Defaults to 1 (see
    // `dispatch-gates.ts:DEFAULT_MAX_CONCURRENT_ISSUES`), preserving the
    // ISS-232 serial-per-project behaviour for every project that does not
    // opt in. Raise it to fan independent issues across the runner pool —
    // dependent issues stay serialized by the L1 issue-busy + L2 blocks/
    // decomposes gates regardless of this value, so only INDEPENDENT issues
    // parallelize. Capped at 20: beyond that, concurrent code/fix sessions on
    // one repo collide at merge often enough that separate projects are the
    // right tool.
    maxConcurrentIssues: z.number().int().min(1).max(20).optional(),
    // ISS-108 Phase 1 / ISS-110 Phase 3 — per-stage enable/mode toggle. When
    // `states[X].enabled === false`, the orchestrator auto-transitions past
    // `X` (soft-skip) rather than dispatching a job. Cycle/dead-end detection
    // runs at PATCH time.
    states: statesConfigSchema,
    // PR-5 — session-group routing.
    sessionGroups: sessionGroupsSchema.optional(),
    onResumeFail: z.enum(['fresh', 'abort']).optional(),
    // ISS-580 — bound the accumulated context a sessionGroup is allowed to
    // resume. When the estimated peak context (MAX(input_tokens+cache_read_tokens)
    // over the group's usage_records) exceeds this value, or the issue's
    // reopenCount exceeds maxResumeReopenCycles, the dispatcher starts a FRESH
    // session instead of resuming — continuity is preserved via the existing
    // handoff/sessionContext mechanism (ISS-537). Set 0 to disable the gate.
    // Defaults: 150000 tokens / 3 reopen cycles.
    maxResumeTokens: z.number().int().min(0).optional(),
    maxResumeReopenCycles: z.number().int().min(0).optional(),
    // ISS-232 — git-aware L2 dependency gate config.
    mergeStates: mergeStatesSchema.optional(),
    // Project-default MCP servers seeded into EVERY job's temp `--mcp-config`
    // (forge-runner --strict-mcp-config makes Claude ignore the runner box's
    // own MCP config, so the project must declare the secret-free servers it
    // wants — playwright, etc.). Same shape as the per-state `mcpServers`; the
    // dispatcher uses this as the BASE, with per-state mcpServers merged on top
    // and integration servers (postman/epodsystem) on top of that. Values may
    // use the catalog shorthand (`name: true`) or a raw custom spec object —
    // see `pipeline/mcp-catalog.ts` `expandMcpServers`.
    mcpServers: z.record(z.string(), z.unknown()).optional(),
    // When true, a `prod`-environment Coolify deploy auto-dispatches on release
    // exactly like `staging` — skipping the human "Confirm production deploy"
    // gate. Default (absent/false) keeps the gate: prod never auto-deploys
    // (safety valve for the autonomous pipeline). Per-project opt-in only.
    autoProdDeploy: z.boolean().optional(),
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
 * Patch payload for `PATCH /pipeline-config`. ISS-232 Phase 3 dropped the
 * sibling `runnerFallback` field — the deterministic v2 selector picks
 * primary → standby with no type-chain fallback. Per-stage `runner`
 * overrides on the step toggles continue to work.
 */
export const pipelineConfigPatchSchema = pipelineConfigSchema;

export type PipelineConfigPatchInput = z.infer<typeof pipelineConfigPatchSchema>;

/**
 * Defaults surfaced by `GET /pipeline-config` when a project has no stored
 * document.
 *
 * ISS-232 Phase 3 — `enabled` defaults to `true` so a freshly-created
 * project's pipeline is live as soon as the project has at least one
 * registered runner. The prior `false` default was a v0 holdover that
 * silently swallowed dispatch attempts on stock setups.
 */
export const PIPELINE_CONFIG_DEFAULTS: PipelineConfig = {
  enabled: true,
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
