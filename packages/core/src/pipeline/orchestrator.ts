import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { PolicyRefusedError } from '../project-config/dispatch-policy.js';
import { readEffectivePolicy } from '../project-config/effective.js';
import type { PolicyDocument } from '../project-config/schema.js';
import type { Actor } from './activity.js';
import {
  AUTONOMOUS_ENTRY_STATUS,
  dispatchAutonomous,
  dispatchDriveManual,
} from './autonomous-dispatch.js';
import type { HooksBus } from './hooks.js';

export { ActiveJobConflictError } from './enqueue-helper.js';

async function loadProjectPolicy(projectId: string): Promise<{
  policy: PolicyDocument | null;
  archived: boolean;
  projectCreatedBy: string | null;
}> {
  const [row] = await db
    .select({ createdBy: projects.createdBy, archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return { policy: null, archived: false, projectCreatedBy: null };
  const projectCreatedBy = row.createdBy ?? null;
  if (row.archivedAt != null) return { policy: null, archived: true, projectCreatedBy };
  const held = await readEffectivePolicy(projectId);
  return { policy: held?.document ?? null, archived: false, projectCreatedBy };
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
  const { policy, projectCreatedBy } = await loadProjectPolicy(args.projectId);
  if (!policy) throw new PolicyRefusedError('POLICY_UNDECLARED', args.projectId, null);
  return dispatchDriveManual({ ...args, projectCreatedBy });
}

export async function reEnqueueForIssue(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  reason: Record<string, unknown>;
}): Promise<void> {
  const { policy, archived, projectCreatedBy } = await loadProjectPolicy(args.projectId);
  if (archived) return;
  if (!policy) {
    logger.warn(
      { projectId: args.projectId, issueId: args.issueId, code: 'POLICY_UNDECLARED' },
      new PolicyRefusedError('POLICY_UNDECLARED', args.projectId, null).message,
    );
    return;
  }
  await dispatchAutonomous({ ...args, policy, projectCreatedBy });
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
