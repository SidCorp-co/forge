/**
 * Heartbeat Service
 *
 * Thin cron tick that scans for pipeline-eligible issues and feeds them
 * into the existing pipeline-orchestrator queue via onStatusChange().
 *
 * Does NOT implement its own dispatch, queue, or capacity tracking —
 * the pipeline-orchestrator, device-pool, and antigravity-runner-pool
 * handle all of that.
 */

import { isPipelinePaused, SESSION_UID, dispatchAllQueued, checkDependenciesResolved } from './pipeline-utils';
import { onStatusChange, STEP_TOGGLES } from './pipeline-orchestrator';
import type { PipelineConfig } from './pipeline-antigravity';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HeartbeatConfig {
  enabled: boolean;
  intervalSeconds: number;  // per-project tick interval, default 60, min 30, max 600
  paused: boolean;
  stages: string[];         // which statuses to auto-process
  maxRetries: number;       // per-issue retry cap, default 3
}

export interface HeartbeatTickResult {
  projectsScanned: number;
  issuesEnqueued: number;
  issuesSkipped: number;
  errors: string[];
}

export interface HeartbeatState {
  initialized: boolean;
  globalPaused: boolean;
  lastTick: string | null;
  lastResult: HeartbeatTickResult | null;
  tickCount: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  enabled: false,
  intervalSeconds: 60,
  paused: false,
  stages: ['open', 'confirmed', 'clarified', 'approved', 'developed', 'testing', 'reopen', 'released'],
  maxRetries: 3,
};

const MAX_HISTORY = 50;

// ─── In-memory State ────────────────────────────────────────────────────────

const lastTickPerProject = new Map<string, number>();
const tickHistory: Array<{ timestamp: string; result: HeartbeatTickResult }> = [];
let lastTickResult: HeartbeatTickResult | null = null;
let tickCount = 0;
let initialized = false;

// ─── Helpers ────────────────────────────────────────────────────────────────

function mergeConfig(raw: any): HeartbeatConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_HEARTBEAT_CONFIG };
  return {
    enabled: raw.enabled === true,
    intervalSeconds: Math.max(30, Math.min(600, Number(raw.intervalSeconds) || 60)),
    paused: raw.paused === true,
    stages: Array.isArray(raw.stages) ? raw.stages : DEFAULT_HEARTBEAT_CONFIG.stages,
    maxRetries: Number(raw.maxRetries) || DEFAULT_HEARTBEAT_CONFIG.maxRetries,
  };
}

/**
 * Compute which statuses the heartbeat should scan for a project.
 * Intersection of heartbeatConfig.stages and statuses with their pipeline toggle enabled.
 */
function getEligibleStatuses(hbConfig: HeartbeatConfig, pipelineConfig: PipelineConfig): string[] {
  return hbConfig.stages.filter((status) => {
    // Custom pipelineSteps: step presence = enabled
    const hasCustomStep = pipelineConfig.pipelineSteps?.some((s) => s.status === status);
    if (hasCustomStep) return true;

    // Default: check toggle
    const toggleKey = STEP_TOGGLES[status];
    if (!toggleKey) return false;
    const stepVal = pipelineConfig[toggleKey];
    if (stepVal === undefined || stepVal === false) return false;
    if (typeof stepVal === 'object' && stepVal !== null && (stepVal as any).enabled === false) return false;
    return true;
  });
}

/**
 * Check if an issue already has a queued or running pipeline session.
 */
async function hasActiveSession(strapi: any, issueDocumentId: string): Promise<boolean> {
  const sessions = await strapi.documents(SESSION_UID).findMany({
    filters: {
      issues: { documentId: { $eq: issueDocumentId } },
      status: { $in: ['queued', 'running'] },
    },
    limit: 1,
  });
  return sessions.length > 0;
}

// ─── Core Tick ──────────────────────────────────────────────────────────────

/**
 * Main heartbeat tick. Scans all heartbeat-enabled projects for
 * pipeline-eligible issues and enqueues them via onStatusChange().
 */
export async function tick(strapi: any, force = false): Promise<HeartbeatTickResult> {
  const result: HeartbeatTickResult = {
    projectsScanned: 0,
    issuesEnqueued: 0,
    issuesSkipped: 0,
    errors: [],
  };

  // Global pause gate
  if (isPipelinePaused()) {
    recordTick(result);
    return result;
  }

  // Query all projects (heartbeatConfig is JSON — filter in JS)
  let projects: any[];
  try {
    projects = await strapi.documents('api::project.project' as any).findMany({
      limit: 100,
    });
  } catch (err: any) {
    result.errors.push(`Failed to query projects: ${err.message}`);
    recordTick(result);
    return result;
  }

  for (const project of projects) {
    const hbConfig = mergeConfig(project.heartbeatConfig);
    if (!hbConfig.enabled || hbConfig.paused) continue;

    // Per-project interval throttle (skip if ticked too recently)
    if (!force) {
      const lastTick = lastTickPerProject.get(project.documentId);
      if (lastTick && Date.now() - lastTick < hbConfig.intervalSeconds * 1000) continue;
    }

    // Pipeline must be enabled
    const pipelineConfig: PipelineConfig = project.agentConfig?.pipelineConfig || { enabled: false };
    if (!pipelineConfig.enabled) continue;

    result.projectsScanned++;
    lastTickPerProject.set(project.documentId, Date.now());

    const eligibleStatuses = getEligibleStatuses(hbConfig, pipelineConfig);
    if (eligibleStatuses.length === 0) continue;

    // Query issues at eligible statuses for this project
    let issues: any[];
    try {
      issues = await strapi.documents('api::issue.issue' as any).findMany({
        filters: {
          project: { documentId: { $eq: project.documentId } },
          status: { $in: eligibleStatuses },
        },
        limit: 50,
      });
    } catch (err: any) {
      result.errors.push(`Project ${project.slug}: failed to query issues: ${err.message}`);
      continue;
    }

    for (const issue of issues) {
      try {
        // Skip if user placed issue on manual hold
        if (issue.manualHold) {
          result.issuesSkipped++;
          continue;
        }

        // Skip if already has an active session
        if (await hasActiveSession(strapi, issue.documentId)) {
          result.issuesSkipped++;
          continue;
        }

        // Skip if blocked by unresolved dependencies — unblockDependents()
        // will re-trigger when blockers complete. Avoids spamming "Pipeline paused" comments.
        if (issue.status === 'clarified' || issue.status === 'approved') {
          const depCheck = await checkDependenciesResolved(strapi, issue.documentId);
          if (depCheck.blocked) {
            result.issuesSkipped++;
            continue;
          }
        }

        // Call onStatusChange with heartbeat flag — same status as from/to
        const sessionId = await onStatusChange(
          strapi,
          issue.documentId,
          issue.status,
          issue.status,
          false,
          { heartbeat: true },
        );

        if (sessionId) {
          result.issuesEnqueued++;
          strapi.log.info(
            `[heartbeat] ISS-${issue.id}: enqueued for ${issue.status} in project ${project.slug}`,
          );
        } else {
          result.issuesSkipped++;
        }
      } catch (err: any) {
        result.errors.push(`ISS-${issue.id}: ${err.message}`);
      }
    }
  }

  // Dispatch any queued sessions that may now have available devices
  // (e.g., device usage limit expired since sessions were queued)
  await dispatchAllQueued(strapi, 'heartbeat');

  recordTick(result);
  return result;
}

function recordTick(result: HeartbeatTickResult): void {
  const entry = { timestamp: new Date().toISOString(), result };
  tickHistory.push(entry);
  if (tickHistory.length > MAX_HISTORY) tickHistory.shift();
  lastTickResult = result;
  tickCount++;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Called from bootstrap. Initializes heartbeat state.
 */
export function startHeartbeat(strapi: any): void {
  initialized = true;
  strapi.log.info('[heartbeat] Heartbeat service initialized (cron handles scheduling)');
}

/**
 * Returns current heartbeat state for the status endpoint.
 */
export function getHeartbeatState(): HeartbeatState {
  return {
    initialized,
    globalPaused: isPipelinePaused(),
    lastTick: tickHistory.length > 0 ? tickHistory[tickHistory.length - 1].timestamp : null,
    lastResult: lastTickResult,
    tickCount,
  };
}

/**
 * Returns tick history for the history endpoint.
 */
export function getHeartbeatHistory(): Array<{ timestamp: string; result: HeartbeatTickResult }> {
  return [...tickHistory];
}

/**
 * Force a heartbeat tick, bypassing per-project interval throttle.
 */
export async function forceHeartbeatTick(strapi: any): Promise<HeartbeatTickResult> {
  return tick(strapi, true);
}
