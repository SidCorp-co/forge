/**
 * A design revision whose only change is the revisions it pins approves by itself (REQ-41 BC-23): no
 * person decides what no person would read differently. The test is `design-repin.ts:pinOnlyChange`,
 * structural over the canonical design and never a text diff; the approval is `recordDecision`, so the
 * event, the design issue's mark and the requirement re-pin (BC-10) follow as for any approval.
 * Anything else changed leaves the revision waiting on a person.
 */

import { say, sayEn } from '@forge/contracts/said';
import { findTemplate, type WorkflowTemplate } from '@forge/contracts/workflow-templates';
import type { Tx } from '../db/client.js';
import { RefusalError } from '../lib/refusal.js';
import type { DesignRefusal } from './design.js';
import { standingBaseRefusal } from './design-bases.js';
import { recordDecision } from './design-record.js';
import { pinOnlyChange } from './design-repin.js';
import { readStoredWorkflow } from './schema.js';
import { designsOf, type StoredWorkflow, workflowsOf } from './store.js';

export interface PinOnlyApproved {
  workflowId: string;
  flow: string;
  revision: number;
  pins: { workflow: string; from: number; to: number }[];
}

export interface PinOnlySettled {
  approved: PinOnlyApproved[];
  /** Revisions that could not be compared and were left to a person, each named. */
  refused: { workflowId: string; refusal: DesignRefusal }[];
}

const uncomparable = (row: StoredWorkflow, what: string): DesignRefusal => ({
  code: 'WORKFLOW_DESIGN_UNCOMPARABLE',
  path: '',
  flow: row.flow,
  detail: `"${row.flow}" has an approved revision and a proposed one, and ${what} is not a design this build can read, so whether only its pins changed cannot be told; it was not approved and waits on a person. Write the design again in a shape the schema reads.`,
});

/**
 * Approves every proposed design of the project whose newest revision differs from its approved one
 * only in its pins and whose bases stand approved, repeating until none moves so a chain of
 * dependents clears base first. Runs inside the project's workflow lock.
 */
export async function settlePinOnly(
  tx: Tx,
  projectId: string,
  templates: readonly WorkflowTemplate[],
): Promise<PinOnlySettled> {
  const out: PinOnlySettled = { approved: [], refused: [] };
  const named = new Set<string>();
  for (let moved = true; moved; ) {
    moved = false;
    const held = await workflowsOf(tx, projectId);
    for (const row of held) {
      if (row.designStatus !== 'proposed' || row.approvedRevision === null) continue;
      const revisions = await designsOf(tx, row.id);
      const proposal = revisions[0];
      if (!proposal || proposal.decision !== null) continue;
      const approvedRow = revisions.find((d) => d.revision === row.approvedRevision);
      const approved = readStoredWorkflow(approvedRow?.document);
      const proposed = readStoredWorkflow(proposal.document);
      if (!approved || !proposed) {
        if (!named.has(row.id)) {
          named.add(row.id);
          out.refused.push({
            workflowId: row.id,
            refusal: uncomparable(
              row,
              approved ? 'its proposed revision' : 'its approved revision',
            ),
          });
        }
        continue;
      }
      const change = pinOnlyChange(approved, proposed, findTemplate(templates, proposed.template));
      if (!change) continue;
      if (standingBaseRefusal(proposal.revision, proposal.document, held)) continue;
      const reason = say('designs.reason.pinOnlyKernel', {
        r: row.approvedRevision,
        pins: change.pins.map((p) => `${p.workflow} r${p.from} → r${p.to}`).join(', '),
        fp: change.fingerprint.slice(0, 12),
      });
      await recordDecision(tx, {
        projectId,
        row: { id: row.id, flow: row.flow, designStatus: row.designStatus },
        designIssueId: proposal.designIssueId,
        revision: proposal.revision,
        decision: 'approve',
        reason: sayEn(reason),
        reasonSays: reason,
        decider: { userId: proposal.proposedByUser, agency: 'agent' },
        kernel: true,
      });
      out.approved.push({
        workflowId: row.id,
        flow: row.flow,
        revision: proposal.revision,
        pins: change.pins,
      });
      moved = true;
      break;
    }
  }
  return out;
}

/** The refusal of a design in hand, thrown so the write that proposed it rolls back and says why. */
export function refuseUncomparable(settled: PinOnlySettled, workflowId: string): void {
  const own = settled.refused.filter((r) => r.workflowId === workflowId).map((r) => r.refusal);
  if (own.length > 0) throw new RefusalError(own, 'WORKFLOW_REFUSED');
}
