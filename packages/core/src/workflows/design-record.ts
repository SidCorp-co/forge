import type { Said } from '@forge/contracts/said';
import type { Tx } from '../db/client.js';
import { recordCorrection } from '../lessons/index.js';
import { emitEvent } from '../outbox/index.js';
import type { DesignDecision } from './design.js';
import { workflowApprovalRecord } from './design-checklist-record.js';
import { type DesignIssueOutcome, parkedAtDecision, recordApprovedDesign } from './design-issue.js';
import { answerDesignQuestions } from './ports.js';
import type { WorkflowWriter } from './service.js';
import { decideDesign, moveDesign, type StoredWorkflow } from './store.js';

/**
 * Everything one decision records, inside a transaction holding the project's workflow lock and after
 * its refusals were read: the decided revision, the design's move, the design issue's mark, the
 * questions it answers and the event.
 */
export async function recordDecision(
  tx: Tx,
  input: {
    projectId: string;
    row: Pick<StoredWorkflow, 'id' | 'flow' | 'designStatus'>;
    designIssueId: string | null;
    revision: number;
    decision: DesignDecision;
    reason: string | null;
    /** `reason` as said, where Forge composed it; absent where the decider wrote it. */
    reasonSays?: Said | null;
    decider: WorkflowWriter;
  },
): Promise<{ parked: boolean; approved: DesignIssueOutcome | null }> {
  const { projectId, row, designIssueId, revision, decision, reason, decider } = input;
  const id = row.id;
  await decideDesign(tx, {
    workflowId: id,
    revision,
    decision,
    userId: decider.userId,
    reason,
    reasonSays: input.reasonSays ?? null,
  });
  await moveDesign(tx, id, row.designStatus, decision === 'approve' ? 'approved' : 'returned', {
    writer: decider,
    reason,
    // an approve is judged by the workflow approval checklist (Requirement lifecycle r15 design_check)
    ...(decision === 'approve'
      ? {
          approvedRevision: revision,
          checklist: {
            record: ({ tx: moveTx, row: moved }) => workflowApprovalRecord(moveTx, moved.id),
          },
        }
      : {}),
  });
  const parked = await parkedAtDecision(tx, designIssueId);
  // the approved revision is its design issue's deliverable: its mark records it (ISS-262)
  const approved =
    decision === 'approve'
      ? await recordApprovedDesign(tx, {
          designIssueId,
          flow: row.flow,
          revision,
          decider,
        })
      : null;
  // the decision is the answer a question waiting on this revision asked for (ISS-254)
  await answerDesignQuestions(tx, {
    workflowId: id,
    revision,
    flow: row.flow,
    decision,
    reason,
    by: decider.userId,
    agency: decider.agency,
  });
  // a returned design's reason is a correction a lesson learns from (REQ-50 BC-1)
  if (decision === 'return') {
    await recordCorrection(tx, {
      projectId,
      source: 'design_returned',
      sourceRef: `${id}:r${revision}`,
      item: { kind: 'workflow', id, key: `${row.flow} r${revision}`, title: row.flow },
      reason,
      by: { userId: decider.userId, agency: decider.agency },
    });
  }
  await emitEvent(tx, 'workflow.designDecided', {
    projectId,
    workflowId: id,
    decision,
    issueId: designIssueId,
  });
  return { parked, approved };
}
