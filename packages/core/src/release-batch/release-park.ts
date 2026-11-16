// ISS-1253 (FB-649, sidpeak 0.27.0, run 1fe92dc2): a release run that reaches a person's gate parks
// there, holding its version and roster, until that person decides. Its job may end while it waits
// (a job pane is concluded once its agent has ended its turn: `runner-core/src/job_exit.rs`
// `IDLE_BEFORE_FINISHED`), and nothing about that ending may close the run, retry it, or hand its
// roster back: the decision carries it on (`confirm-resume.ts:carryReleaseRunOn`). The one reading
// of whether a run is parked, which the job kernel and the sweeps read through the pipeline port.

import type { ActorAgency } from '@forge/contracts/permissions';
import { LIVE_PIPELINE_RUN_STATUSES, type PipelineRunStatus } from '@forge/contracts/run-machine';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { releaseApprovals } from '../db/schema-release-ledger.js';
import { peopleOf } from '../lib/people.js';
import { holderNames } from '../permissions/index.js';
import { gateOf } from '../project-config/index.js';
import { readAbortStamp } from './abort-stamp.js';
import { pendingProdConfirmOf } from './coolify-prod-gate.js';
import { releaseBatchPath } from './plan.js';
import { refuseRelease } from './refuse.js';

/** The person's gate an open release run is parked at, and what it holds while it waits. */
export type ReleasePark =
  | { gate: 'approval'; runId: string; version: string; approvalId: string }
  | { gate: 'confirm'; runId: string; version: string; bindingId: string };

/**
 * Where release run `runId` is parked on a person, or null where it is not: an open, unshipped,
 * unaborted release run whose latest approval request is undecided under an enforced
 * `release_approval` gate (the gate `approvals.ts:assertApprovalAllowsAttempt` refuses its
 * production act by), or whose production deploy waits on a person's confirm (ISS-1096).
 */
export async function releaseRunParked(runId: string): Promise<ReleasePark | null> {
  const [run] = await db
    .select({
      projectId: pipelineRuns.projectId,
      status: pipelineRuns.status,
      version: pipelineRuns.releaseVersion,
      releasedAt: pipelineRuns.releaseReleasedAt,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (
    !run?.version ||
    run.releasedAt !== null ||
    !LIVE_PIPELINE_RUN_STATUSES.includes(run.status as PipelineRunStatus)
  )
    return null;
  if (readAbortStamp(run.metadata) !== null) return null;
  const [latest] = await db
    .select({ id: releaseApprovals.id, decision: releaseApprovals.decision })
    .from(releaseApprovals)
    .where(and(eq(releaseApprovals.runId, runId), eq(releaseApprovals.projectId, run.projectId)))
    .orderBy(desc(releaseApprovals.requestedAt), desc(releaseApprovals.id))
    .limit(1);
  if (latest && latest.decision === null) {
    const gate = await gateOf(run.projectId, 'release_approval');
    if (gate.mode === 'enforce') {
      return { gate: 'approval', runId, version: run.version, approvalId: latest.id };
    }
  }
  const confirm = pendingProdConfirmOf(run.metadata);
  return confirm
    ? { gate: 'confirm', runId, version: run.version, bindingId: confirm.bindingId }
    : null;
}

/** The park as one sentence, for a log line and the reason a skipped close records. */
export function parkSentence(park: ReleasePark): string {
  return park.gate === 'approval'
    ? `release ${park.version} (run ${park.runId}) is parked on its approval request ${park.approvalId}, holding its version and roster until a person decides it`
    : `release ${park.version} (run ${park.runId}) is parked on a person's confirm of its production deploy through binding ${park.bindingId}, holding its version and roster until it is pressed`;
}

/**
 * An agent's abort of a release run parked on its undecided approval is refused by name (REQ-71
 * BC-1, BC-15): the run holds its version and roster for the approver, and only their decision or a
 * person withdrawing it ends the run. A returned approval opens the abort again; a person (agency
 * `human`) withdraws the release with the same door.
 */
export async function refuseAbortWhileParked(runId: string, agency: ActorAgency): Promise<void> {
  if (agency === 'human') return;
  const park = await releaseRunParked(runId);
  if (park?.gate !== 'approval') return;
  const [request] = await db
    .select({
      projectId: releaseApprovals.projectId,
      requestedBy: releaseApprovals.requestedByUser,
      requestedAt: releaseApprovals.requestedAt,
    })
    .from(releaseApprovals)
    .where(eq(releaseApprovals.id, park.approvalId))
    .limit(1);
  if (!request) return;
  const [asker, approvers] = await Promise.all([
    peopleOf([request.requestedBy]),
    holderNames('releases.approve', request.projectId),
  ]);
  const askedBy = asker.get(request.requestedBy)?.name ?? request.requestedBy;
  const deciders =
    approvers.length > 0 ? approvers.join(', ') : 'nobody: no one holds releases.approve';
  const path = `/api/${releaseBatchPath(request.projectId, runId)}`;
  throw refuseRelease(
    'RELEASE_ABORT_AWAITS_APPROVAL',
    `release ${park.version} (run ${runId}) is parked on approval request ${park.approvalId}, asked by ${askedBy} at ${request.requestedAt.toISOString()} and decided by ${deciders}. It holds its version and roster until that decision: an approval carries this run on, a return opens this abort, and a person withdraws the release with POST ${path}/abort. Do not abort it for the wait; end your turn, and the decision reaches this run.`,
  );
}
