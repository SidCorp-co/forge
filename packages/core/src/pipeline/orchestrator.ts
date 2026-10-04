import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, projects } from '../db/schema.js';
import { logger } from '../observability/logger.js';
import { consume } from '../outbox/index.js';
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

/**
 * The pipeline orchestrator, a consumer of issue moves and creations: creation lands an issue at
 * its birth status without a move, so covering it needs both. A failure is redelivered with
 * backoff, and a delivery that runs out of attempts is dead, raised by the outbox's ops alert.
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
  });
}
