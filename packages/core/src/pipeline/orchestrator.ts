import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, projects } from '../db/schema.js';
import { logger } from '../observability/logger.js';
import { consume, MAX_REDELIVERIES } from '../outbox/index.js';
import { policyRefusal } from '../project-config/dispatch-policy.js';
import { readEffectivePolicy } from '../project-config/effective.js';
import type { PolicyDocument } from '../project-config/schema.js';
import type { Actor } from './activity.js';
import {
  AUTONOMOUS_ENTRY_STATUS,
  dispatchAutonomous,
  dispatchDriveManual,
  isEntryGateClosed,
} from './autonomous-dispatch.js';
import { refusePipeline } from './refuse.js';
import { emitPipelineWedge } from './wedge.js';

/** Why a person's start on an issue changes nothing. */
const intakeNotManual = (projectId: string) =>
  refusePipeline(
    'INTAKE_NOT_MANUAL',
    `project ${projectId} has policy intake \`auto\`, so its masters take every issue at \`${AUTONOMOUS_ENTRY_STATUS}\` without a person starting it. Starting one by hand is only for a project whose policy says \`intake: { mode: "manual" }\`.`,
  );

const projectArchived = (projectId: string) =>
  refusePipeline(
    'PROJECT_ARCHIVED',
    `project ${projectId} is archived, so nothing dispatches there. Restore the project before starting its issues.`,
  );

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
 * A person starting an issue on a project whose policy intake is `manual` (ISS-29). It OFFERS the
 * issue rather than minting work for it (ISS-933): the stamp is what admits the entry row to its
 * masters, and a master opens the run itself.
 */
export async function triggerPipelineStepManual(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  reason: Record<string, unknown>;
}): Promise<{ startedAt: string }> {
  const { policy, archived, projectCreatedBy } = await loadProjectPolicy(args.projectId);
  if (archived) throw projectArchived(args.projectId);
  if (!policy) throw policyRefusal('POLICY_UNDECLARED', args.projectId, null);
  if (!isEntryGateClosed(policy)) throw intakeNotManual(args.projectId);
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
      policyRefusal('POLICY_UNDECLARED', args.projectId, null).refusals[0]?.detail,
    );
    return;
  }
  await dispatchAutonomous({ ...args, policy, projectCreatedBy });
}

/** An issue the pipeline could not be handed after every redelivery is a wedge a person sees. */
async function wedgeUndispatched(
  p: { projectId: string; issueId: string; to: string; from?: string },
  error: string,
  eventId: string,
): Promise<void> {
  const move = p.from ? `transition ${p.from} → ${p.to}` : `creation at ${p.to}`;
  await emitPipelineWedge({
    projectId: p.projectId,
    issueId: p.issueId,
    hop: 'dispatch',
    entity: 'outbox',
    entityId: eventId,
    reason: `${move} failed after ${MAX_REDELIVERIES} redeliveries: ${error}`,
    action:
      'Inspect the pipeline_outbox row + orchestrator logs; the issue may be sitting at its trigger status with no job.',
    title: 'Status change not processed',
    summary: `An issue's move to "${p.to}" could not be handed to the pipeline after ${MAX_REDELIVERIES} retries, so no next step was started.`,
    nextStep:
      'Open the issue and re-apply the status change, or check the server logs for the failing consumer.',
  });
}

/**
 * The pipeline orchestrator, a consumer of issue moves and creations: creation lands an issue at
 * its birth status without a move, so covering it needs both. A failure is redelivered, and the
 * last one wedges the issue.
 */
export function registerPipelineOrchestrator(): void {
  consume('issue.transitioned', {
    name: 'pipeline-orchestrator',
    handle: async (p) => {
      if (p.to !== AUTONOMOUS_ENTRY_STATUS) return;
      await reEnqueueForIssue({
        projectId: p.projectId,
        issueId: p.id,
        status: p.to,
        actor: p.actor,
        reason: { transition: { from: p.from, to: p.to } },
      });
    },
    onDeadLetter: (p, error, d) =>
      wedgeUndispatched(
        { projectId: p.projectId, issueId: p.id, from: p.from, to: p.to },
        error,
        d.eventId,
      ),
  });

  consume('issue.created', {
    name: 'pipeline-orchestrator',
    handle: async (p) => {
      await reEnqueueForIssue({
        projectId: p.projectId,
        issueId: p.issueId,
        status: p.status,
        actor: p.actor,
        reason: { created: true },
      });
    },
    onDeadLetter: (p, error, d) =>
      wedgeUndispatched(
        { projectId: p.projectId, issueId: p.issueId, to: p.status },
        error,
        d.eventId,
      ),
  });
}
