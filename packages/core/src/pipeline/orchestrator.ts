// Dispatch, for the one lane this pipeline has.
//
// This file used to hold both drivers: a staged walk that enqueued one job per
// status behind eight `auto<Stage>` toggles, and the autonomous driver beside
// it. ISS-897 removed the toggles from `pipelineConfigSchema`, and because the
// read path parses through that schema, `isToggleEnabled` answered false for
// every stage on every project — the staged branch stopped being reachable the
// moment the key stopped being parseable. What is left is the walk from a
// transition to `dispatchAutonomous`, and the manual Run button.
//
// Config parsing lives here rather than in `autonomous-dispatch.ts` because
// the hook fires per transition and the config read is what a human-gated
// status must not pay for.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, type JobType, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import type { Actor } from './activity.js';
import {
  AUTONOMOUS_ENTRY_STATUS,
  dispatchAutonomous,
  dispatchDriveManual,
} from './autonomous-dispatch.js';
import type { HooksBus } from './hooks.js';
import { type PipelineConfig, pipelineConfigSchema } from './pipeline-config-schema.js';

export { ActiveJobConflictError } from './enqueue-helper.js';

async function loadPipelineConfig(
  projectId: string,
): Promise<{ cfg: PipelineConfig | null; projectCreatedBy: string | null }> {
  const [row] = await db
    .select({
      agentConfig: projects.agentConfig,
      createdBy: projects.createdBy,
      archivedAt: projects.archivedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return { cfg: null, projectCreatedBy: null };
  // ISS-353 — archived projects pause auto-pipeline dispatch. cfg=null falls
  // through to the same "no auto pipeline" path as a missing/invalid config,
  // so no NEW agent jobs are queued. In-flight jobs are untouched (this only
  // gates dispatch, not running work).
  if (row.archivedAt != null) return { cfg: null, projectCreatedBy: row.createdBy ?? null };
  const ac = (row.agentConfig as { pipelineConfig?: unknown } | null) ?? {};
  // Parse through the canonical schema so the typed read path stays in
  // lockstep with what was validated on write. Bad data → cfg=null (caller
  // falls through to "no auto pipeline" behavior, same as missing row).
  const parsed = pipelineConfigSchema.safeParse(ac.pipelineConfig ?? {});
  return {
    cfg: parsed.success ? parsed.data : null,
    projectCreatedBy: row.createdBy ?? null,
  };
}

/**
 * Manual fire from the issue UI (ISS-5): the whole drive session. Bypasses
 * every automation gate — the user clicked "Run". Throws
 * `ActiveJobConflictError` when a drive job for this issue is already active
 * so the route can return 409.
 */
export async function triggerPipelineStepManual(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  reason: Record<string, unknown>;
}): Promise<{ jobId: string; type: JobType }> {
  const { projectCreatedBy } = await loadPipelineConfig(args.projectId);
  return dispatchDriveManual({ ...args, projectCreatedBy });
}

async function considerEnqueue(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  reason: Record<string, unknown>;
}): Promise<void> {
  const { cfg, projectCreatedBy } = await loadPipelineConfig(args.projectId);
  if (!cfg?.enabled) return;
  await dispatchAutonomous({ ...args, cfg, projectCreatedBy });
}

/**
 * Re-export for the self-healing sweeper (Phase H, ISS-306) and the
 * reconciler. Same entry point the hook subscribers use, so a salvage does
 * not have to fire a synthetic `transition` hook (which would mutate
 * activity_log / WS broadcasts in confusing ways).
 */
export async function reEnqueueForIssue(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  reason: Record<string, unknown>;
}): Promise<void> {
  return considerEnqueue(args);
}

/**
 * Subscribe the pipeline orchestrator to `transition` and `issueCreated`
 * hooks. Issue creation lands the issue in `open` without emitting a
 * `transition`, so covering the manual-creation path needs both.
 *
 * Register only in the main process boot block — it touches the DB and pg-boss.
 */
export function registerPipelineOrchestrator(bus: HooksBus): void {
  bus.on(
    'transition',
    async (payload) => {
      try {
        // cm:guard leaving a park dispatches like any other transition (RFC 0002 INV-6) — do NOT re-add an actor or reason gate here. The guard deleted from this spot refused every non-user exit from `waiting`/`on_hold`; on ISS-163 it refused four legitimate resume attempts in a row and produced no work at all. Entering a park is free from anywhere, so leaving one is too.
        // cm:guard `needs_info -> open` MUST reach dispatch. It is how an answered question resumes, and the staged-era short-circuit that returned here left the issue `open` with no job — which the board renders as running, the one failure shape nobody thinks to check.
        // cm:why the entry-status short-circuit runs BEFORE loadPipelineConfig so every other transition costs no DB hit; `dispatchAutonomous` reaches the same answer one query later
        if (payload.to !== AUTONOMOUS_ENTRY_STATUS) return;
        await considerEnqueue({
          projectId: payload.projectId,
          issueId: payload.issueId,
          status: payload.to,
          actor: payload.actor,
          reason: { transition: { from: payload.from, to: payload.to } },
        });
      } catch (err) {
        logger.error(
          { err, issueId: payload.issueId, to: payload.to },
          'orchestrator: transition handler failed',
        );
        // cm:edge contract -> packages/core/src/pipeline/hooks.ts — rethrow so HooksBus records this subscriber in EmitResult.failures and the outbox stops stamping the row processed; the bus still runs the remaining subscribers and never throws at the emitter, so the isolation this local catch used to provide is unchanged
        throw err;
      }
    },
    { name: 'pipeline-orchestrator' },
  );

  bus.on(
    'issueCreated',
    async (payload) => {
      try {
        await considerEnqueue({
          projectId: payload.projectId,
          issueId: payload.issueId,
          status: payload.status,
          actor: payload.actor,
          reason: { created: true },
        });
      } catch (err) {
        logger.error(
          { err, issueId: payload.issueId },
          'orchestrator: issueCreated handler failed',
        );
        throw err;
      }
    },
    { name: 'pipeline-orchestrator' },
  );
}
