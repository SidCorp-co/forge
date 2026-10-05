import { LIVE_JOB_STATUSES } from '@forge/contracts/job-machine';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, jobs, projects } from '../db/schema.js';
import { type Actor, stampRunStarted } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import {
  AUTONOMOUS_ENTRY_STATUS,
  isAutonomousEntry,
  isEntryGateClosed,
} from './autonomous-mode.js';
import {
  type ProjectPolicy,
  policyRefusal,
  readEffectivePolicy,
  wakeMastersForProject,
} from './ports.js';
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

const notAtEntry = (status: IssueStatus) =>
  refusePipeline(
    'NOT_AT_ENTRY_STATUS',
    `the driver is handed an issue at \`${AUTONOMOUS_ENTRY_STATUS}\`, this one is at \`${status}\`; move it back to \`${AUTONOMOUS_ENTRY_STATUS}\` to have a master take it again`,
  );

async function loadProjectPolicy(projectId: string): Promise<ProjectPolicy> {
  const [row] = await db
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (row?.archivedAt != null) throw projectArchived(projectId);
  const held = row ? await readEffectivePolicy(projectId) : null;
  if (!held?.document) throw policyRefusal('POLICY_UNDECLARED', projectId, null);
  return held.document;
}

/**
 * A person starting an issue on a project whose policy intake is `manual` (ISS-29). It OFFERS the
 * issue rather than minting work for it (ISS-933): the stamp is what admits the entry row to its
 * masters, and a master opens the run itself. The first start's time is kept, so a second press
 * reports when the issue was started rather than restarting its clock.
 */
export async function triggerPipelineStepManual(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  reason: Record<string, unknown>;
}): Promise<{ startedAt: string }> {
  const policy = await loadProjectPolicy(args.projectId);
  if (!isEntryGateClosed(policy)) throw intakeNotManual(args.projectId);
  if (!isAutonomousEntry(args.status)) throw notAtEntry(args.status);
  const startedAt = await stampRunStarted(args.issueId);
  if (!startedAt) throw new Error(`issue ${args.issueId} vanished while it was being started`);
  await wakeMastersForProject({
    projectId: args.projectId,
    issueId: args.issueId,
    status: args.status,
  });
  logger.info(
    { projectId: args.projectId, issueId: args.issueId, startedAt },
    'orchestrator: started by a person — offered to this project masters',
  );
  return { startedAt };
}

/**
 * Retry a failed pipeline session's issue through the path every dispatch takes: the issue sits at
 * the entry status and the project's masters are woken to take it. A manual-intake project's issue
 * is also admitted, as a person's start would. Refused by name when nothing would take it.
 */
export async function retryIssueDispatch(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
}): Promise<{ boxes: number; delivered: number; startedAt: string | null }> {
  const policy = await loadProjectPolicy(args.projectId);
  if (!isAutonomousEntry(args.status)) throw notAtEntry(args.status);

  const [active] = await db
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.issueId, args.issueId), inArray(jobs.status, [...LIVE_JOB_STATUSES])))
    .limit(1);
  if (active) {
    throw refusePipeline(
      'ACTIVE_JOB_CONFLICT',
      `job ${active.id} is already ${active.status} for this issue; it finishes or is cancelled before a retry is offered`,
    );
  }

  const wake = await wakeMastersForProject({
    projectId: args.projectId,
    issueId: args.issueId,
    status: args.status,
  });
  if (wake.boxes === 0) {
    throw refusePipeline(
      'NO_MASTER_SERVING',
      `no runner box serves project ${args.projectId}, so no master can take the retry; pair a runner to the project, then retry`,
    );
  }

  let startedAt: string | null = null;
  if (isEntryGateClosed(policy)) {
    startedAt = await stampRunStarted(args.issueId);
    if (!startedAt) throw new Error(`issue ${args.issueId} vanished while it was being retried`);
  }
  logger.info(
    { projectId: args.projectId, issueId: args.issueId, boxes: wake.boxes, startedAt },
    'orchestrator: retry offered to this project masters',
  );
  return { boxes: wake.boxes, delivered: wake.delivered, startedAt };
}
