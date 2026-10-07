// A decision on a release's approval request is told to the release run that asked, in its own
// session, the way an answer reaches the run that asked a question (`pipeline/answer-resume.ts`):
// the run is waiting on it, and until this nothing reached its pane but a person typing there.

import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { requestSessionSend } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { agentSessions, jobs, terminalAgentSessionStatuses } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { peopleOf } from '../lib/people.js';
import { consume } from '../outbox/index.js';
import { releaseBatchPath } from './plan.js';

type Decided = OutboxEventPayload<'release.approvalDecided'>;

/** The live session of the release job that runs this batch, or `null` where none is alive. */
export async function releaseRunSession(runId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: agentSessions.id })
    .from(jobs)
    .innerJoin(agentSessions, eq(agentSessions.id, jobs.agentSessionId))
    .where(
      and(
        eq(jobs.pipelineRunId, runId),
        eq(jobs.type, 'release_batch'),
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
      ),
    )
    .orderBy(desc(jobs.queuedAt))
    .limit(1);
  return row?.id ?? null;
}

/** What the run reads in its pane: the decision, who made it, and what it may do next. */
export function decisionMessage(p: Decided, decidedBy: string): string {
  const path = `/api/${releaseBatchPath(p.projectId, p.runId)}`;
  if (p.decision === 'approved') {
    return `Release approval ${p.approvalId} was APPROVED by ${decidedBy} at ${p.decidedAt}. The production acts of release run ${p.runId} are allowed now: carry on with the release, and read the decision back with GET ${path}/state if you need it.`;
  }
  return `Release approval ${p.approvalId} was RETURNED by ${decidedBy} at ${p.decidedAt}: "${p.reason ?? ''}". No production act is allowed on release run ${p.runId}. Answer that reason, then ask again with POST ${path}/approvals, or abort the batch with the reason.`;
}

type Told = 'sent' | 'unpublished' | 'no_session';

/** Hand the decision to the session that asked, idempotent per approval request. */
export async function tellReleaseRun(p: Decided): Promise<Told> {
  const sessionId = await releaseRunSession(p.runId);
  if (!sessionId) {
    logger.warn(
      { runId: p.runId, approvalId: p.approvalId, decision: p.decision },
      'release-approval-wake: no live release session to tell; the decision stands on the run for the next one to read',
    );
    return 'no_session';
  }
  const name = (await peopleOf([p.decidedBy])).get(p.decidedBy)?.name ?? p.decidedBy;
  const { published } = await requestSessionSend({
    agentSessionId: sessionId,
    kind: 'answer',
    intentId: p.approvalId,
    body: decisionMessage(p, name),
  });
  logger.info(
    { runId: p.runId, approvalId: p.approvalId, sessionId, published },
    'release-approval-wake: the decision was handed to the release session that asked',
  );
  return published ? 'sent' : 'unpublished';
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
