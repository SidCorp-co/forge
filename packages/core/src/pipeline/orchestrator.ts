import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, projects } from '../db/schema.js';
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
  if (row.archivedAt != null) return { cfg: null, projectCreatedBy: row.createdBy ?? null };
  const ac = (row.agentConfig as { pipelineConfig?: unknown } | null) ?? {};
  const parsed = pipelineConfigSchema.safeParse(ac.pipelineConfig ?? {});
  return {
    cfg: parsed.success ? parsed.data : null,
    projectCreatedBy: row.createdBy ?? null,
  };
}

/**
 * Manual fire from the issue UI (ISS-5). Since ISS-933 this OFFERS the issue
 * rather than minting work for it: core no longer starts a drive session, a
 * master opens the run itself, and a human's Run is the per-issue release that
 * a project-level gate cannot express.
 */
export async function triggerPipelineStepManual(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  reason: Record<string, unknown>;
}): Promise<{ released: true }> {
  const { projectCreatedBy } = await loadPipelineConfig(args.projectId);
  return dispatchDriveManual({ ...args, projectCreatedBy });
}

export async function reEnqueueForIssue(args: {
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
        if (payload.to !== AUTONOMOUS_ENTRY_STATUS) return;
        await reEnqueueForIssue({
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
        throw err;
      }
    },
    { name: 'pipeline-orchestrator' },
  );

  bus.on(
    'issueCreated',
    async (payload) => {
      try {
        await reEnqueueForIssue({
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
