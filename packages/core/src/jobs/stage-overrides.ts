/**
 * Dispatcher-time helper to resolve per-state overrides for a job.
 *
 * Looks up `projects.agentConfig.pipelineConfig.states[<stageStatus>]`,
 * where `stageStatus` was stamped onto `job.payload` by the orchestrator at
 * enqueue time. Returns a normalized `StageOverrides` shape with all fields
 * optional — defaults mirror the previous hardcoded behavior.
 *
 * The dispatcher reads these to:
 *   1. Choose the right system prompt (append/replace + extras).
 *   2. Pick per-state model / allowedTools / mcpServers / timeoutSeconds.
 *   3. Forward to the runner via `job.assigned` WS payload.
 *
 * Per-state user prompt policy (`userPromptPolicy`) is consumed at enqueue
 * time by the orchestrator, so the resulting `promptString` already
 * reflects it — the dispatcher does not need to re-apply it.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { expandMcpServers } from '../pipeline/mcp-catalog.js';
import type {
  BudgetConfig,
  StageConfig,
  SystemPromptOverrideConfig,
} from '../pipeline/pipeline-config-schema.js';
import { validateStagePolicy } from '../security/config-policy.js';

export interface StageOverrides {
  systemPrompt: SystemPromptOverrideConfig | null;
  model: string | null;
  allowedTools: string[] | null;
  disallowedTools: string[] | null;
  permissionMode: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | null;
  timeoutSeconds: number | null;
  mcpServers: Record<string, unknown> | null;
  budget: BudgetConfig | null;
  sessionGroup: string | null;
}

const EMPTY: StageOverrides = {
  systemPrompt: null,
  model: null,
  allowedTools: null,
  disallowedTools: null,
  permissionMode: null,
  timeoutSeconds: null,
  mcpServers: null,
  budget: null,
  sessionGroup: null,
};

/**
 * ISS-535 — explicit per-stage model-routing policy (single source of truth).
 *
 * Keyed by issue STATUS (the `stageStatus` stamped on the job payload — the
 * same key `resolveStageOverrides` looks up). Applies to EVERY project
 * automatically whenever the per-project `pipelineConfig.states[status].model`
 * is null, and is overridable per-project by setting that `.model`.
 *
 * Values are TIER ALIASES (`haiku`/`sonnet`/`opus`), passed verbatim to
 * `claude --model` (claude_code.rs forwards the string as-is). Aliases resolve
 * to the current model in each family, so the policy stays stable across model
 * bumps — unlike dated full IDs (`claude-opus-4-8`, …), which rot. The aliases
 * match the `modelTiers` enum, so they are already valid `--model` values.
 *
 * Policy: cheap (haiku) for mechanical classify/close steps, balanced (sonnet)
 * for reproduce/code/merge, deep (opus) for the high-leverage plan & review.
 * `fix` (reopen) starts at sonnet and ESCALATES via {@link escalateModel}.
 * Statuses absent from this table (staging/custom/pm/smoke) fall through to the
 * dispatcher's `job.modelTier ?? 'default'`.
 */
export const DEFAULT_STAGE_MODELS: Record<string, string> = {
  open: 'haiku', // triage — classify, cheap
  confirmed: 'sonnet', // clarify — reproduce/validate
  clarified: 'opus', // plan — architecture, high leverage
  approved: 'sonnet', // code — balanced
  developed: 'opus', // review — bug-catching, high leverage
  testing: 'sonnet', // test — merge + E2E, mechanical
  reopen: 'sonnet', // fix — base tier; escalates with reopenCount
  released: 'haiku', // release — changelog + close
};

/** Tier ladder for {@link escalateModel}. Index = cost/capability rank. */
const MODEL_TIER_LADDER = ['haiku', 'sonnet', 'opus'] as const;

/**
 * The default model tier for a stage status, or null when the status is not in
 * the policy table (caller then falls through to its own default).
 */
export function resolveDefaultModel(stageStatus: string): string | null {
  return DEFAULT_STAGE_MODELS[stageStatus] ?? null;
}

/**
 * ISS-535 escalation — bump a tier-alias model up the ladder by `reopenCount`
 * steps, clamped to the top tier (`opus`). Used for `fix`/`review` jobs so a
 * reopened issue retries at a stronger model (ECC "upgrade-on-failure").
 *
 * Passes the model through unchanged when: it is null, it is not a known tier
 * alias (a custom full-ID override can't be laddered), or `reopenCount <= 0`.
 */
export function escalateModel(model: string | null, reopenCount: number): string | null {
  if (!model || reopenCount <= 0) return model;
  const idx = MODEL_TIER_LADDER.indexOf(model as (typeof MODEL_TIER_LADDER)[number]);
  if (idx < 0) return model; // not a ladder alias — leave custom overrides alone
  const next = Math.min(idx + reopenCount, MODEL_TIER_LADDER.length - 1);
  // `next` is a clamped, in-bounds index, so this is always defined.
  return MODEL_TIER_LADDER[next] ?? model;
}

/**
 * Read the stage status the orchestrator stamped on the job's payload at
 * enqueue time. Returns null for legacy jobs (pre-PR-4) — caller falls
 * through to no-override behavior.
 */
export function extractStageStatus(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>).stageStatus;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Load the project's pipelineConfig.states sub-tree once per dispatch. */
async function loadStageMap(projectId: string): Promise<Record<string, StageConfig> | null> {
  try {
    const [row] = await db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row?.agentConfig) return null;
    const ac = row.agentConfig as Record<string, unknown>;
    const pc = ac.pipelineConfig as Record<string, unknown> | undefined;
    if (!pc || typeof pc !== 'object') return null;
    const states = (pc as { states?: unknown }).states;
    if (!states || typeof states !== 'object') return null;
    return states as Record<string, StageConfig>;
  } catch (err) {
    // Per-state overrides are best-effort; a DB hiccup should NOT crash a
    // dispatch — but operators need to see the degradation. Log and proceed
    // with defaults (no per-state overrides applied this dispatch).
    logger.warn(
      { err, projectId },
      'stage-overrides: failed to load pipelineConfig.states, dispatching with defaults',
    );
    return null;
  }
}

/**
 * Load the project-default MCP servers from
 * `pipelineConfig.mcpServers` and expand the catalog shorthand into full
 * specs. This is the BASE of the dispatch mcpServers merge: per-state
 * `mcpServers` and the integration servers (postman/epodsystem) layer on top.
 *
 * Best-effort like {@link resolveStageOverrides}: a DB hiccup or absent config
 * returns an empty map (no project defaults this dispatch). Always returns a
 * fresh object — never a shared reference into the cached drizzle row.
 */
export async function resolveProjectDefaultMcpServers(
  projectId: string,
): Promise<Record<string, unknown>> {
  try {
    const [row] = await db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const ac = (row?.agentConfig ?? null) as Record<string, unknown> | null;
    const pc = ac?.pipelineConfig as Record<string, unknown> | undefined;
    const raw = (pc as { mcpServers?: unknown } | undefined)?.mcpServers;
    if (!raw || typeof raw !== 'object') return {};
    return expandMcpServers(raw as Record<string, unknown>);
  } catch (err) {
    logger.warn(
      { err, projectId },
      'stage-overrides: failed to load pipelineConfig.mcpServers, dispatching without project defaults',
    );
    return {};
  }
}

export async function resolveStageOverrides(
  projectId: string,
  payload: unknown,
): Promise<StageOverrides> {
  const stageStatus = extractStageStatus(payload);
  // Return a fresh copy, never the shared EMPTY singleton by reference, so a
  // caller that mutates the result (e.g. the dispatcher layering the Postman
  // mcpServers entry) cannot pollute the singleton for later dispatches.
  if (!stageStatus) return { ...EMPTY };

  const states = await loadStageMap(projectId);
  const stage = states?.[stageStatus];
  // ISS-535 — projects with NO per-state config (or no entry for this status)
  // still get the default model-routing policy. Everything else stays EMPTY.
  if (!stage) return { ...EMPTY, model: resolveDefaultModel(stageStatus) };

  // config-policy: non-blocking warn pass (ISS-539).
  const policyFindings = validateStagePolicy(stageStatus, stage, resolveDefaultModel(stageStatus));
  if (policyFindings.length > 0) {
    logger.warn(
      { projectId, stageStatus, findings: policyFindings },
      'config-policy: pipeline stage policy warnings',
    );
  }

  // Shallow-clone object/array fields so callers that mutate the result
  // (e.g. layer project defaults onto mcpServers, push extra tools onto
  // allowedTools) never leak changes back into the cached drizzle row
  // reference. Primitive fields are safe to pass through.
  return {
    systemPrompt: stage.systemPrompt ? { ...stage.systemPrompt } : null,
    // ISS-535 — per-project `.model` WINS; otherwise the default policy applies.
    model: stage.model ?? resolveDefaultModel(stageStatus),
    allowedTools: stage.allowedTools ? [...stage.allowedTools] : null,
    disallowedTools: stage.disallowedTools ? [...stage.disallowedTools] : null,
    permissionMode: stage.permissionMode ?? null,
    timeoutSeconds: stage.timeoutSeconds ?? null,
    mcpServers: stage.mcpServers ? { ...(stage.mcpServers as Record<string, unknown>) } : null,
    budget: stage.budget ? { ...stage.budget } : null,
    sessionGroup: stage.sessionGroup ?? null,
  };
}
