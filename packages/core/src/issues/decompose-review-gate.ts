import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import type { Actor } from '../pipeline/activity.js';
import { withActorContext } from '../pipeline/outbox-session.js';
import { setCurrentStepForOpenIssueRun } from '../pipeline/runs.js';
import { publishIssueStatusChange } from './apply-transition.js';
import { publishPipelineHealthChanged } from './pipeline-health.js';
import { postTransitionReasonComment } from './transition-reason.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface ParentReviewGate {
  actorId: string;
  fromStatus: IssueStatus;
  updatedAt: Date;
}

export interface ParentReviewGateInput {
  parentAlreadyDecomposed: boolean;
  parentId: string;
  parentStatus: IssueStatus;
  projectId: string;
  hasActiveDecomposition: boolean;
  childIds: string[];
}

export async function parkDecomposedParent(
  tx: Tx,
  input: ParentReviewGateInput,
  actor: Actor,
): Promise<ParentReviewGate | null> {
  if (
    input.parentAlreadyDecomposed ||
    input.parentStatus === 'waiting' ||
    !input.hasActiveDecomposition
  ) {
    return null;
  }

  const reason = `Decomposed into ${input.childIds.length} child issue${input.childIds.length === 1 ? '' : 's'}. Review the split, then approve this parent to promote every child from \`draft\` to \`approved\`. The parent's own integration work runs LAST, after every child's code has merged.`;
  // cm:guard write the review gate in the decomposition transaction — an after-commit stale transition could promote draft children before split review, leaving the parent integration work dispatchable against an unreviewed graph
  await postTransitionReasonComment(
    {
      issueId: input.parentId,
      authorId: actor.id,
      fromStatus: input.parentStatus,
      toStatus: 'waiting',
      reason,
      waitingKind: 'needs_decision',
      isAi: actor.type !== 'user',
    },
    tx,
  );
  // cm:edge sideeffect -> packages/core/drizzle/migrations/0070_pipeline_outbox.sql — the direct status write must stay inside withActorContext so its trigger records an attributed outbox row
  const [updated] = await withActorContext(tx, actor, null, (executor) =>
    executor
      .update(issues)
      .set({ status: 'waiting', waitingKind: 'needs_decision', updatedAt: sql`now()` })
      .where(and(eq(issues.id, input.parentId), eq(issues.status, input.parentStatus)))
      .returning({ updatedAt: issues.updatedAt }),
  );
  if (!updated) throw new Error('STALE_TRANSITION: parent status changed during decomposition');
  return { actorId: actor.id, fromStatus: input.parentStatus, updatedAt: updated.updatedAt };
}

export async function finalizeDecomposedParentReviewGate(
  input: ParentReviewGateInput,
  reviewGate: ParentReviewGate | null,
): Promise<void> {
  if (!reviewGate) return;
  publishIssueStatusChange(input.projectId, {
    issueId: input.parentId,
    from: reviewGate.fromStatus,
    to: 'waiting',
    reopenCount: 0,
    actorId: reviewGate.actorId,
    reason: null,
    at: reviewGate.updatedAt,
  });
  await publishPipelineHealthChanged(input.projectId, [input.parentId]);
  await setCurrentStepForOpenIssueRun(input.parentId, 'waiting');
}
