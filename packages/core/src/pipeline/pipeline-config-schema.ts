import { z } from 'zod';
import {
  INTEGRATION_SERVER_NAMES,
  isKnownMcpServerName,
  MCP_CATALOG_NAMES,
} from './mcp-catalog.js';
/**
 * Per-stage `{ enabled, mode }` config under `pipelineConfig.states`, keyed by
 * the kernel status the config applies at.
 *
 * These are the four non-terminal statuses the one lane has. Only `open`
 * dispatches — `autonomousStepFor` returns a step there and nowhere else — so
 * the other three carry prompt/tool policy for a session that is already
 * running or resuming, never a dispatch decision.
 */
// cm:guard the staged ladder (`confirmed` `clarified` `approved` `developed` `testing` `tested`) was removed here by ISS-897, and this schema STRIPS unknown keys — so re-adding one of those names does not just widen a union, it un-deletes a stage the settings surface no longer shows and the orchestrator no longer walks. A key here must be a status this lane actually reaches.
// cm:edge contract -> packages/core/src/pipeline/autonomous-mode.ts — the same four statuses AUTONOMOUS_DRIVER_STATUSES names minus the terminals; a stage name that is not a driver status is config for a state no issue on this lane is ever in
export const STAGE_NAMES = ['open', 'in_progress', 'needs_info', 'released'] as const;

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
     * Step-handoff injection. Absent means ON — the resolved default lives in
     * `pipeline/handoff-policy.ts`, not in the `.default()` below, which only
     * fires when a project sends a partial object.
     *
     * The prompt builder renders prior handoffs under `## Prior step handoffs`,
     * drops the raw `description` / `plan` a present handoff already carries,
     * and appends a termination block asking for this step's own.
     */
    // cm:guard the handoff is CONTEXT, never a gate, and this block carried two knobs that said otherwise for as long as they existed: `requireHandoffWrite` and `missingMarkerPolicy` described `POST /api/jobs/:id/complete` failing a job for a missing row or a missing `DONE` marker. No such check exists — the axis-separation decision removed it deliberately, and the one place that still reads a handoff (`jobs/finalize-done.ts`) does the opposite, rescuing a job the runner called failed. Both were removed on 2026-09-02 with 0 projects setting either. Re-adding one re-opens a decision, so make it there, not here.
    handoffs: z
      .object({
        enabled: z.boolean().default(false),
        injectFromSteps: z
          .array(
            z.enum([
              'triage',
              'clarify',
              'plan',
              'code',
              'review',
              'test',
              'stage',
              'release',
              'fix',
              'drive',
            ]),
          )
          .default([]),
        fallbackToRawIssueFieldIfMissing: z.boolean().default(true),
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

// cm:why every field is optional so a PATCH may send one stage key without resending the rest, and there is no `.passthrough()`: `mergePipelineConfig` round-trips legacy TOP-LEVEL keys by spread, while a stage-level key this object does not name is dropped on purpose
export const stageConfigSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['auto', 'manual']).optional(),
  skillName: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(64).optional(),
  allowedTools: z.array(z.string().min(1).max(128)).max(100).nullable().optional(),
  // cm:guard ISS-531 — forwarded as Claude Code's `--disallowed-tools`, which is a real DENYLIST: it removes the tool from the available SET even under `--permission-mode bypassPermissions` (verified on claude v2.1.185), so this is the only knob that hard-denies rather than merely un-approving. It is independent of `allowedTools` and the CLI applies allow THEN deny, so a name in both is denied — putting a tool on the allow list does not rescue it from here.
  disallowedTools: z.array(z.string().min(1).max(128)).max(100).nullable().optional(),
  permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
  timeoutSeconds: z.int().positive().max(86_400).optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  // Prompt content overrides — orchestrator + dispatcher resolve before stamping.
  systemPrompt: systemPromptOverrideSchema.optional(),
  userPromptPolicy: userPromptPolicySchema.optional(),
  // Budget caps (consumed by dispatcher pre-flight + in-flight kill paths).
  budget: budgetConfigSchema.optional(),
  // cm:why per-state runner pool: unset/empty = whole fleet (pre-pool behaviour), one element = a hard pin, and every other selection rule still applies WITHIN the pool rather than being replaced by it
  // cm:edge contract -> packages/core/src/runners/select.ts — apply the pool INSIDE the candidate query next to rate_limited_until, never as an exclude set: the retry rotation deliberately clears its exclusions when a round wraps, which would evaporate a pool expressed that way
  // cm:guard an all-busy/all-limited pool leaves the job queued — never widen the pool to place it, or the operator loses the guarantee that a stage ran where they pinned it
  deviceIds: z.array(z.uuid()).max(20).optional(),
});

export type StageConfig = z.infer<typeof stageConfigSchema>;

export const statesConfigSchema = z
  .partialRecord(z.enum(STAGE_NAMES), stageConfigSchema)
  .optional();

export type StatesConfig = z.infer<typeof statesConfigSchema>;

/**
 * ISS-581 — agency tools the driver does not need. A session that implements an
 * issue has no reason to create schedules, run workflows or trigger remote
 * jobs; denying them bounds the blast radius if one behaves unexpectedly.
 * `allowedTools` is intentionally NOT set: an allowlist must enumerate every
 * builtin and is fragile on CLI upgrades, whereas a denylist is expansion-safe.
 */
const DRIVER_DEFAULT_DISALLOWED = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'Workflow',
  'RemoteTrigger',
  'ScheduleWakeup',
];

export function defaultStatesConfig(): Record<StageName, StageConfig> {
  return Object.fromEntries(
    STAGE_NAMES.map((s) => [
      s,
      { enabled: true, mode: 'auto' as const, disallowedTools: [...DRIVER_DEFAULT_DISALLOWED] },
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
 */
// cm:guard the strip is the DELETION MECHANISM for a removed key, so removing a row here is a data change on every project: the next settings save drops that key from the stored document. ISS-897 removed the eight `autoX` step toggles, `sessionGroups`, `mergeStates`, `states[x].sessionGroup` and `states[x].skipComplexities` this way, paired with a migration that did it at once rather than leaving 38 projects half-stripped. Do not remove a key whose reader still branches on it.
export const pipelineConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    // ISS-606 — per-project intake gate. When enabled, EVERY create that
    // would land at `open` (all channels, member-created included) is parked
    // at `draft` + label `intake`; a human approves via the existing
    // draft→open transition. `notify` (default true) pings the project owner
    // on each gated arrival. Absent = off — other projects are unchanged.
    intakeGate: z
      .object({
        enabled: z.boolean(),
        notify: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // cm:guard absent means OFF, and that is the whole point of the field: this producer ran on every project from a pg-boss cron nobody could see, and the owner who owns the fleet could not say what it was doing. Enabling it costs runner capacity — each proposal is an `open` issue that auto-triages into a pipeline run — so a project opts in, and `candidatesPerRun` is the only thing bounding the first night on a project with a large eligible pool (1,014 fleet-wide on 2026-09-05).
    // cm:edge contract -> packages/core/src/memory/consolidation.ts — `proposeKnowledgePromotions` is the only reader; it runs inside the nightly `memory-consolidation` job, so a project that never flips this never sees a promotion issue
    knowledgePromotion: z
      .object({
        enabled: z.boolean(),
        candidatesPerRun: z.number().int().min(1).max(10).optional(),
        minRetrievals: z.number().int().min(1).max(100).optional(),
      })
      .strict()
      .optional(),
    // ISS-108 Phase 1 / ISS-110 Phase 3 — per-stage enable/mode toggle. When
    // `states[X].enabled === false`, the orchestrator auto-transitions past
    // `X` (soft-skip) rather than dispatching a job. Cycle/dead-end detection
    // runs at PATCH time.
    states: statesConfigSchema,
    // cm:why ISS-580 — a resume carries the prior session's whole context, so past a peak the fresh session plus its handoff is cheaper and no less informed; 0 disables the bound, absent means 150000 tokens / 3 reopen cycles (jobs/resume-policy.ts)
    maxResumeTokens: z.number().int().min(0).optional(),
    // cm:guard advisory ONLY (RFC 0002 INV-8) — this replaced `REOPEN_CAP`, and the whole point is that nothing in core reads it to make a decision. It is rendered into the agent's `## Project Config` block and judged by the agent; a dispatch gate or transition that branches on it re-creates the cap that parked issues which were making progress.
    reopenPolicy: z
      .object({
        noProgressRounds: z.number().int().min(1).max(100),
      })
      .strict()
      .optional(),
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
    // cm:guard MUST stay declared here — this schema STRIPS unknown keys, so a lock that is not in the object literal is dropped by PATCH /pipeline-config and silently never takes effect, while skills/lock.ts keeps reporting the project as unlocked
    // cm:edge contract -> packages/core/src/skills/lock.ts — readLockedSkills() parses exactly this field; `false` and a malformed value read as ABSENT there, never as "unlocked"
    lockedSkills: z.union([z.boolean(), z.array(z.string())]).optional(),
    // cm:guard ships ABSENT, which reads as `duplex` since the ISS-873 phase 5 flip. The key survives the flip for exactly one release as the opt-OUT: `print` is the escape a project reaches for if residency misbehaves, and phase 6 deletes both the key and the lane it names. Removing this key from the schema REQUIRES the stored-config migration first (invariant 6) — this object is `.strict()`, so a stored config still carrying `sessionMode` fails validation for the whole project the moment the key leaves.
    sessionMode: z.enum(['print', 'duplex']).optional(),
    // cm:guard NO READER on the runner side yet, so the declared default of 0 is in force nowhere — the ceiling actually enforced is `SESSION_IDLE_TIMEOUT` (claude_code.rs). Only core reads this today, as the residency backstop in jobs/park-deadline.ts. Giving it the runner reader means 0 becomes the fleet default and turns residency OFF for every project that has not opted in, which is why it lands with the phase 5 flip and not before: raising it trades a held duplex slot for the park fast path, so it is a capacity decision, never a latency tweak.
    sessionResidencySeconds: z.number().int().min(0).max(3600).optional(),
  })
  .superRefine((cfg, ctx) => {
    // ISS-623 W1 — reject a `name: true` mcpServers shorthand entry whose
    // name is neither a catalog server nor a known integration sentinel.
    // Without this, a typo (`shop` vs `epodsystem`) is silently dropped by
    // `expandMcpServers` at dispatch time with only a `logger.warn` — the
    // agent never sees the server and the operator has to read core source
    // to find out why. Object-valued raw specs and `false`/`null` opt-outs
    // are untouched (they are not shorthand, so there is no "known name" to
    // check).
    const checkMcpServers = (
      map: Record<string, unknown> | undefined,
      path: (string | number)[],
    ) => {
      if (!map) return;
      for (const [name, value] of Object.entries(map)) {
        if (value !== true) continue;
        if (isKnownMcpServerName(name)) continue;
        ctx.addIssue({
          code: 'custom',
          path: [...path, name],
          message: `mcpServers entry "${name}" is not a known catalog server (${MCP_CATALOG_NAMES.join(', ')}) or integration (${INTEGRATION_SERVER_NAMES.join(', ')}, epodsystem_<label>) — fix the name or use an object spec for a custom server`,
        });
      }
    };
    checkMcpServers(cfg.mcpServers, ['mcpServers']);
    if (cfg.states) {
      for (const [stageName, stageCfg] of Object.entries(cfg.states)) {
        if (!stageCfg || typeof stageCfg !== 'object') continue;
        checkMcpServers((stageCfg as { mcpServers?: Record<string, unknown> }).mcpServers, [
          'states',
          stageName,
          'mcpServers',
        ]);
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
