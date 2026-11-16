// A decision on a release's approval request is told to the release run that asked, in its own
// session, the way an answer reaches the run that asked a question (`pipeline/answer-resume.ts`):
// the run is waiting on it, and until this nothing reached its pane but a person typing there. A
// release that merges change requests runs no job and holds no session: its merges are the master's,
// so its decision wakes the project's master instead, which reads what it owes on that wake
// (`merges-owed.ts`, `masters/owed.ts`; REQ-71 BC-4).

import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { peopleOf } from '../lib/people.js';
import { consume } from '../outbox/index.js';
import { readProjectDocument } from '../project-config/index.js';
import { projectCreatorOf } from '../projects/index.js';
import { mergeStepsOf, type ReleaseMergeStep } from './change-request-roster.js';
import { settleChangeRequestRelease } from './change-request-settle.js';
import { resolveReleaseChannels } from './channel.js';
import { carryReleaseRunOn, type ResumeOutcome } from './confirm-resume.js';
import { productionAsksConfirm } from './coolify-prod-gate.js';
import { releaseBatchPath } from './plan.js';
import { wakeMastersForRelease } from './provider-live.js';

type Decided = OutboxEventPayload<'release.approvalDecided'>;

/** What the run reads in its pane: the decision, who made it, and what it may do next. */
export function decisionMessage(p: Decided, decidedBy: string, asksConfirm = false): string {
  const path = `/api/${releaseBatchPath(p.projectId, p.runId)}`;
  if (p.decision === 'approved') {
    // an event recorded before ISS-914 has no carried list
    const carried = p.carried ?? [];
    const carriedLine =
      carried.length === 0
        ? ''
        : ` It carried ${carried.length} unproven ${carried.length === 1 ? 'criterion' : 'criteria'} by the approver's word (${carried.map((c) => `${c.issue} #${c.n}`).join(', ')}); each stays owed after the release.`;
    // ISS-1096: production deploys on request, so its deploy parks for a person's confirm next
    const confirmLine = asksConfirm
      ? ` Its production deploy then waits on a project admin's confirm: when the deploy answers pendingHumanConfirm, hold the run open and wait for that press, never abort it.`
      : '';
    return `Release approval ${p.approvalId} was APPROVED by ${decidedBy} at ${p.decidedAt}.${carriedLine} The production acts of release run ${p.runId} are allowed now: carry on with the release, and read the decision back with GET ${path}/state if you need it.${confirmLine}`;
  }
  return `Release approval ${p.approvalId} was RETURNED by ${decidedBy} at ${p.decidedAt}: "${p.reason ?? ''}". No production act is allowed on release run ${p.runId}. Answer that reason, then ask again with POST ${path}/approvals, or abort the batch with the reason.`;
}

type Told = ResumeOutcome | 'master_woken' | 'no_master' | 'settled';

/** The merge order of a release that merges change requests, which runs no job; null otherwise. */
async function mergeOrder(runId: string): Promise<ReleaseMergeStep[] | null> {
  const [run] = await db
    .select({ metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  return mergeStepsOf(run?.metadata);
}

/**
 * Hand the decision to whoever acts on it, idempotent per approval request: the session that asked,
 * or, on a release that merges change requests, the project's master. One with nothing to merge,
 * every issue already on the target branch, settles on its approval: nobody has an act left.
 */
export async function tellReleaseRun(p: Decided): Promise<Told> {
  const steps = await mergeOrder(p.runId);
  if (steps?.length === 0 && p.decision === 'approved') {
    // the release closes its roster as a host merge's settle does: on the project's behalf
    const owner = await projectCreatorOf(p.projectId);
    if (!owner)
      throw new Error(`release run ${p.runId}: project ${p.projectId} has no creator to settle as`);
    const out = await settleChangeRequestRelease(p.runId, {
      type: 'user',
      id: owner,
      agency: 'agent',
    });
    if (out.pending === 'stamps' || out.pending === 'settling') {
      throw new Error(
        `release run ${p.runId}: approved with nothing to merge, and the settle waits on ${out.pending}; retried`,
      );
    }
    return 'settled';
  }
  if (steps) {
    const { delivered } = await wakeMastersForRelease(p.projectId);
    logger.info(
      { runId: p.runId, approvalId: p.approvalId, decision: p.decision, delivered },
      delivered > 0
        ? 'release-approval-wake: the decision woke the master that merges the release'
        : 'release-approval-wake: no master box heard the decision; its next sweep reads the merges it owes',
    );
    return delivered > 0 ? 'master_woken' : 'no_master';
  }
  const name = (await peopleOf([p.decidedBy])).get(p.decidedBy)?.name ?? p.decidedBy;
  const [channels, held] = await Promise.all([
    resolveReleaseChannels(p.projectId),
    readProjectDocument(p.projectId),
  ]);
  // the run that asked may have parked with its job ended (ISS-1253): the decision then queues the
  // release job that carries it on, under the version it was cut with, rather than waiting for nobody
  const told = await carryReleaseRunOn({
    projectId: p.projectId,
    runId: p.runId,
    intentId: p.approvalId,
    body: decisionMessage(p, name, productionAsksConfirm(channels, held?.document)),
  });
  logger.info(
    { runId: p.runId, approvalId: p.approvalId, decision: p.decision, told },
    'release-approval-wake: the decision was handed to what carries the release run on',
  );
  return told;
}

/** Register the consumer. Called once at boot from `outbox-consumers.ts`. */
export function registerReleaseApprovalWake(): void {
  consume('release.approvalDecided', {
    name: 'release-approval-wake',
    handle: async (p) => {
      await tellReleaseRun(p);
    },
  });
}
