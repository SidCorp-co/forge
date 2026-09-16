import { z } from 'zod';
import { issueStatuses } from '../db/schema.js';
import { ENTRY_CRITERION_KEYS } from '../issues/entry-criteria-keys.js';
import {
  AUTONOMOUS_ENTRY_STATUS,
  AUTONOMOUS_SKILL_NAME,
  BACKLOG_ADMISSIBLE_STATUSES,
} from './autonomous-mode.js';
import {
  INTEGRATION_SERVER_NAMES,
  isKnownMcpServerName,
  MCP_CATALOG_NAMES,
} from './mcp-catalog.js';
import { QA_JUDGEMENT_KEY, QA_JUDGEMENT_MODES } from './qa-judgement.js';
/**
 * Per-stage config under `pipelineConfig.states`, keyed by the kernel status
 * the config applies at.
 *
 * A name belongs here when a session can be AT that status carrying this
 * project's prompt and tool policy — which `resolveStageOverrides` looks up by
 * the status stamped on the job. Only `open` dispatches (`autonomousStepFor`
 * returns a step there and nowhere else), and `awaiting_release` is here
 * because `BACKLOG_ADMISSIBLE_STATUSES` admits it and a master opens a session
 * over it.
 */
export const STAGE_NAMES = ['open', 'in_progress', 'needs_info', 'awaiting_release'] as const;

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

export const stageConfigSchema = z.object({
  enabled: z.boolean().optional(),
  model: z.string().min(1).max(64).optional(),
  allowedTools: z.array(z.string().min(1).max(128)).max(100).nullable().optional(),
  disallowedTools: z.array(z.string().min(1).max(128)).max(100).nullable().optional(),
  permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
  timeoutSeconds: z.int().positive().max(86_400).optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  systemPrompt: systemPromptOverrideSchema.optional(),
  userPromptPolicy: userPromptPolicySchema.optional(),
  budget: budgetConfigSchema.optional(),
  /**
   * ISS-969 — the component a comment body written at this stage must carry.
   *
   * Absent is OFF, and absent is where every project starts: `defaultStatesConfig()`
   * does not name this key, so nothing acquires a mandate by upgrading.
   */
  deviceIds: z.array(z.uuid()).max(20).optional(),
});

export type StageConfig = z.infer<typeof stageConfigSchema>;

export const entryStageConfigSchema = stageConfigSchema.extend({
  mode: z.enum(['auto', 'manual']).optional(),
});

export type EntryStageConfig = z.infer<typeof entryStageConfigSchema>;

/**
 * ISS-917 — per-project pool admission. Declares which issue statuses a master
 * agent may SEE as a backlog beside the claimable pool, and how many rows it
 * may read at once.
 *
 * Absent or `statuses: []` is today's behaviour exactly: no backlog, and
 * `GET /api/devices/me/pool` answers with the same `items` it always did.
 */
export const poolBacklogSchema = z
  .object({
    statuses: z.array(z.enum(BACKLOG_ADMISSIBLE_STATUSES as [string, ...string[]])).max(16),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export type PoolBacklogConfig = z.infer<typeof poolBacklogSchema>;

export const statesConfigSchema = z
  .strictObject({
    open: entryStageConfigSchema.optional(),
    in_progress: stageConfigSchema.optional(),
    needs_info: stageConfigSchema.optional(),
    awaiting_release: stageConfigSchema.optional(),
  })
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

export function defaultStatesConfig(): NonNullable<StatesConfig> {
  const base = (): StageConfig => ({
    enabled: true,
    disallowedTools: [...DRIVER_DEFAULT_DISALLOWED],
  });
  return {
    open: { ...base(), mode: 'auto' },
    in_progress: base(),
    needs_info: base(),
    awaiting_release: base(),
  };
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
export const pipelineConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    intakeGate: z
      .object({
        enabled: z.boolean(),
        notify: z.boolean().optional(),
      })
      .strict()
      .optional(),
    knowledgePromotion: z
      .object({
        enabled: z.boolean(),
        candidatesPerRun: z.number().int().min(1).max(10).optional(),
        minRetrievals: z.number().int().min(1).max(100).optional(),
      })
      .strict()
      .optional(),
    assistantWeekly: z
      .object({
        enabled: z.boolean(),
        pinnedIssue: z.string().regex(/^[A-Z]{2,6}-\d+$/, 'an issue key such as ISS-1060'),
        judgeProviderId: z.string().min(1),
        judgeModel: z.string().min(1),
        source: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    poolBacklog: poolBacklogSchema.optional(),
    states: statesConfigSchema,
    maxResumeTokens: z.number().int().min(0).optional(),
    reopenPolicy: z
      .object({
        noProgressRounds: z.number().int().min(1).max(100),
      })
      .strict()
      .optional(),
    mcpServers: z.record(z.string(), z.unknown()).optional(),
    autoProdDeploy: z.boolean().optional(),
    lockedSkills: z.union([z.boolean(), z.array(z.string())]).optional(),
    sessionResidencySeconds: z.number().int().min(0).max(3600).optional(),
    [QA_JUDGEMENT_KEY]: z.enum(QA_JUDGEMENT_MODES).optional(),
    statusEntryCriteria: z
      .partialRecord(z.enum(issueStatuses), z.array(z.enum(ENTRY_CRITERION_KEYS)).min(1).max(16))
      .optional(),
  })
  .superRefine((cfg, ctx) => {
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
    if (cfg.intakeGate?.enabled === true && cfg.poolBacklog?.statuses?.includes('draft')) {
      ctx.addIssue({
        code: 'custom',
        path: ['poolBacklog', 'statuses'],
        message:
          'intakeGate is on, which parks every new issue at `draft` for a human to approve — so `draft` cannot also be admitted to `poolBacklog.statuses`, which lets a master approve it instead. Turn off `intakeGate`, or admit a status other than `draft`.',
      });
    }

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
 * Patch payload for `PATCH /pipeline-config` and MCP `forge_config` action
 * `update`.
 *
 * It is the canonical schema plus the refusals that run on the RAW body,
 * before the parse strips anything: a `states[X].mode` at any status other
 * than the entry status, and a `states[X].skillName` at any status at all. The
 * two schemas differ in exactly that, and each caller wants the one it has — a
 * WRITE is told what does not reach, a READ of a stored document must never be
 * refused.
 */
export function refuseRetiredStageKeys(
  states: unknown,
  ctx: z.RefinementCtx,
  at: (string | number)[] = ['states'],
): void {
  if (!states || typeof states !== 'object') return;
  for (const [stage, stageCfg] of Object.entries(states as Record<string, unknown>)) {
    if (!stageCfg || typeof stageCfg !== 'object') continue;
    if ('mode' in stageCfg && stage !== AUTONOMOUS_ENTRY_STATUS) {
      ctx.addIssue({
        code: 'custom',
        path: [...at, stage, 'mode'],
        message: `states.${stage}.mode does not gate anything — \`mode\` is read only at the entry status \`${AUTONOMOUS_ENTRY_STATUS}\`, where it decides whether a human releases work. To hold work at ${stage}, there is no such gate; to hold it before it starts, set states.${AUTONOMOUS_ENTRY_STATUS}.mode = "manual". Remove states.${stage}.mode and resend.`,
      });
    }
    if ('skillName' in stageCfg) {
      ctx.addIssue({
        code: 'custom',
        path: [...at, stage, 'skillName'],
        message: `states.${stage}.skillName selects nothing, at this or any stage — no dispatcher reads it. Every autonomous dispatch runs the one driver skill \`${AUTONOMOUS_SKILL_NAME}\`, which reaches a runner through this project's \`plugins\` designation rather than through a per-stage name. Remove states.${stage}.skillName and resend.`,
      });
    }
  }
}

export const pipelineConfigPatchSchema = z
  .unknown()
  .superRefine((raw, ctx) =>
    refuseRetiredStageKeys((raw as { states?: unknown } | null | undefined)?.states, ctx),
  )
  .pipe(pipelineConfigSchema);

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
