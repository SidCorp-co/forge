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
import type {
  BudgetConfig,
  StageConfig,
  SystemPromptOverrideConfig,
} from '../pipeline/pipeline-config-schema.js';

export interface StageOverrides {
  systemPrompt: SystemPromptOverrideConfig | null;
  model: string | null;
  allowedTools: string[] | null;
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
  permissionMode: null,
  timeoutSeconds: null,
  mcpServers: null,
  budget: null,
  sessionGroup: null,
};

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
async function loadStageMap(
  projectId: string,
): Promise<Record<string, StageConfig> | null> {
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

export async function resolveStageOverrides(
  projectId: string,
  payload: unknown,
): Promise<StageOverrides> {
  const stageStatus = extractStageStatus(payload);
  if (!stageStatus) return EMPTY;

  const states = await loadStageMap(projectId);
  const stage = states?.[stageStatus];
  if (!stage) return EMPTY;

  // Shallow-clone object/array fields so callers that mutate the result
  // (e.g. layer project defaults onto mcpServers, push extra tools onto
  // allowedTools) never leak changes back into the cached drizzle row
  // reference. Primitive fields are safe to pass through.
  return {
    systemPrompt: stage.systemPrompt ? { ...stage.systemPrompt } : null,
    model: stage.model ?? null,
    allowedTools: stage.allowedTools ? [...stage.allowedTools] : null,
    permissionMode: stage.permissionMode ?? null,
    timeoutSeconds: stage.timeoutSeconds ?? null,
    mcpServers: stage.mcpServers
      ? { ...(stage.mcpServers as Record<string, unknown>) }
      : null,
    budget: stage.budget ? { ...stage.budget } : null,
    sessionGroup: stage.sessionGroup ?? null,
  };
}
