import type { DesignRevisionState } from '@forge/contracts/design-status';
import type { DesignBuildGate, DesignWaitingOn } from '@forge/contracts/workflows';
import type { DesignDecision, DesignStatus } from './design.js';

export interface DesignHeadFacts {
  status: DesignStatus | null;
  proposedRevision: number | null;
  approvedRevision: number | null;
}

export interface DesignStandingInput extends DesignHeadFacts {
  latest: { revision: number; author: string | null } | null;
  canDecide: boolean;
}

const wait = (
  kind: DesignWaitingOn['kind'],
  who: string,
  act: string,
  rule: string,
): DesignWaitingOn => ({ kind, who, act, rule });

function proposedWait(input: DesignStandingInput, revision: number): DesignWaitingOn {
  const act = `approve or return revision ${revision}`;
  if (input.canDecide) {
    return wait('you', 'You', act, `revision ${revision} is proposed and you may decide it`);
  }
  return wait(
    'person',
    'A holder of workflow-designs.approve',
    act,
    'a design is decided by whoever holds workflow-designs.approve on the project (project admin, or an org owner or admin), person or agent',
  );
}

// cm:why whose turn a design is, first rule wins: proposed → its approver (you when you may decide);
// returned or draft → the master that writes it (a holder of workflow-designs.write); approved or
// not under approval → nobody
export function designWaitingOn(input: DesignStandingInput): DesignWaitingOn {
  const latest = input.latest?.revision ?? null;
  const writer = input.latest?.author ?? 'Master';
  switch (input.status) {
    case 'proposed':
      return proposedWait(input, input.proposedRevision ?? latest ?? 1);
    case 'returned':
      return wait(
        'agent',
        writer,
        latest === null ? 'revise it' : `revise revision ${latest}`,
        'a returned design is revised by its master writing it, which proposes the next revision',
      );
    case 'draft':
      return wait(
        'agent',
        writer,
        'finish and propose it',
        'a draft design is proposed once its master finishes drawing it',
      );
    case 'approved':
      return wait(
        'none',
        'Nobody',
        '',
        `revision ${input.approvedRevision ?? latest ?? 1} is approved; work that builds it may start`,
      );
    default:
      return wait('none', 'Nobody', '', 'this workflow is not under design approval');
  }
}

// cm:why the gate is `build-gate.ts:designUnapprovedSql` read for one design: an issue that builds it
// is dispatched only while its status is approved, so a newer proposal holds builds again
export function buildGateOf(head: DesignHeadFacts): DesignBuildGate {
  if (head.status === 'approved') {
    return {
      open: true,
      rule: `issues that build it may be dispatched: revision ${head.approvedRevision ?? '?'} is approved`,
    };
  }
  const why =
    head.status === null
      ? 'the design has no approval yet'
      : head.status === 'proposed'
        ? `revision ${head.proposedRevision ?? '?'} waits on its approver`
        : `the design is ${head.status}`;
  return {
    open: false,
    rule: `issues that build it are held out of dispatch until a revision is approved; ${why}`,
  };
}

export function revisionStateOf(
  revision: { revision: number; decision: DesignDecision | string | null },
  head: DesignHeadFacts,
): DesignRevisionState {
  if (revision.revision === head.approvedRevision) return 'current';
  if (revision.decision === 'return') return 'returned';
  if (head.status === 'proposed' && revision.revision === head.proposedRevision) return 'proposed';
  return 'superseded';
}
