import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { collectDeclaredMcpNames, expandMcpServers } from '../pipeline/mcp-catalog.js';
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
  /**
   * Per-state runner pool. Null (or an empty list, normalized to null here)
   * means the whole project fleet is eligible — the dispatcher passes this
   * straight to `onlineCapableDeviceIds` as `allowDeviceIds`.
   */
  deviceIds: string[] | null;
  declaredNames: string[] | null;
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
  deviceIds: null,
  declaredNames: null,
};

export const SKILL_MAINTENANCE_LABEL = 'skill-maintenance';

export const SKILL_MAINTENANCE_TOOLS = [
  'mcp__forge__forge_skills_update',
  'mcp__forge__forge_skills_push',
  'mcp__forge__forge_skills_sync_status',
] as const;

export function applySkillMaintenanceCarveout(
  overrides: StageOverrides,
  opts: { hasSkillMaintenanceLabel: boolean; jobType: string },
): number {
  if (!opts.hasSkillMaintenanceLabel) return 0;
  if (opts.jobType !== 'code' && opts.jobType !== 'fix') return 0;
  if (!overrides.disallowedTools) return 0;
  const before = overrides.disallowedTools.length;
  overrides.disallowedTools = overrides.disallowedTools.filter(
    (t) => !SKILL_MAINTENANCE_TOOLS.includes(t as (typeof SKILL_MAINTENANCE_TOOLS)[number]),
  );
  return before - overrides.disallowedTools.length;
}

export const DEFAULT_STAGE_MODELS: Record<string, string> = {
  open: 'sonnet',
  in_progress: 'sonnet',
  needs_info: 'sonnet',
  awaiting_release: 'sonnet',
};

/**
 * The default model tier for a stage status, or null when the status is not in
 * the policy table (caller then falls through to its own default).
 */
export function resolveDefaultModel(stageStatus: string): string | null {
  return DEFAULT_STAGE_MODELS[stageStatus] ?? null;
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
    logger.warn(
      { err, projectId },
      'stage-overrides: failed to load pipelineConfig.states, dispatching with defaults',
    );
    return null;
  }
}

/**
 * Every MCP server name declared under a per-state `pipelineConfig.states.*.mcpServers` override,
 * deduplicated across states.
 *
 * A project-wide resolution carries none of these: they reach an agent only on a dispatch at that
 * state. A surface reporting the project-wide set names them rather than omitting them, which is
 * what ISS-1191 was filed for.
 */
export async function stateDeclaredMcpNames(projectId: string): Promise<string[]> {
  const states = await loadStageMap(projectId);
  if (!states) return [];
  return [...collectDeclaredMcpNames({ states })];
}

/** Return shape of {@link resolveProjectDefaultMcpServers}. */
export interface ProjectDefaultMcpServers {
  /** Expanded servers (catalog shorthand → full spec) — the merge BASE. */
  servers: Record<string, unknown>;
  /**
   * ISS-623 W2 — truthy raw keys from `pipelineConfig.mcpServers`
   * pre-expansion, so the dispatcher can tell a declared-but-dropped name
   * (e.g. an unknown catalog shorthand) from one that was never declared.
   */
  declaredNames: string[];
}

export async function resolveProjectDefaultMcpServers(
  projectId: string,
): Promise<ProjectDefaultMcpServers> {
  try {
    const [row] = await db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const ac = (row?.agentConfig ?? null) as Record<string, unknown> | null;
    const pc = ac?.pipelineConfig as Record<string, unknown> | undefined;
    const raw = (pc as { mcpServers?: unknown } | undefined)?.mcpServers;
    if (!raw || typeof raw !== 'object') return { servers: {}, declaredNames: [] };
    return {
      servers: expandMcpServers(raw as Record<string, unknown>),
      declaredNames: [...collectDeclaredMcpNames({ mcpServers: raw as Record<string, unknown> })],
    };
  } catch (err) {
    logger.warn(
      { err, projectId },
      'stage-overrides: failed to load pipelineConfig.mcpServers, dispatching without project defaults',
    );
    return { servers: {}, declaredNames: [] };
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
    deviceIds: stage.deviceIds && stage.deviceIds.length > 0 ? [...stage.deviceIds] : null,
    declaredNames: stage.mcpServers
      ? [...collectDeclaredMcpNames({ mcpServers: stage.mcpServers as Record<string, unknown> })]
      : null,
  };
}
