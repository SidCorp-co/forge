import type { DesignRevisionState, DesignStatus } from '@forge/contracts/design-status';
import { type Said, say, sayEn } from '@forge/contracts/said';
import { type WaitingOn, waitingOn } from '@forge/contracts/standing';
import type {
  DesignBuildGate,
  DesignListReading,
  DesignWaitingKind,
} from '@forge/contracts/workflows';
import type { DesignDecision } from './design.js';

type DesignWaitingOn = WaitingOn<DesignWaitingKind>;

interface DesignHeadFacts {
  status: DesignStatus | null;
  proposedRevision: number | null;
  approvedRevision: number | null;
}

interface DesignStandingInput extends DesignHeadFacts {
  latest: { revision: number; author: string | null } | null;
  canDecide: boolean;
  /** The refusal approving the proposed revision would meet on its bases now (`standingBaseRefusal`). */
  baseUnapproved?: { code: string; detail: string } | null;
}

const wait = (kind: DesignWaitingKind, who: Said, act: Said, rule: Said): DesignWaitingOn =>
  waitingOn(kind, { who, act, rule });

const NOBODY = say('standing.who.nobody');
const NO_ACT = say('standing.act.none');

function proposedWait(input: DesignStandingInput, revision: number): DesignWaitingOn {
  const act = say('designs.act.approveOrReturn', { r: revision });
  if (input.canDecide) {
    return wait(
      'you',
      say('standing.who.you'),
      act,
      say('designs.rule.youDecide', { r: revision }),
    );
  }
  return wait(
    'person',
    say('standing.who.holderOf', { perm: 'workflow-designs.approve' }),
    act,
    say('designs.rule.approverDecides'),
  );
}

// Whose turn a design is, first rule wins: proposed → its approver (you when you may decide);
// returned → the project's master, which `owed-designs.ts` carries it to; draft → the writer drawing
// it; approved or not under approval → nobody
export function designWaitingOn(input: DesignStandingInput): DesignWaitingOn {
  const latest = input.latest?.revision ?? null;
  const author = input.latest?.author;
  const writer = author ? say('standing.who.named', { name: author }) : say('standing.who.master');
  switch (input.status) {
    case 'proposed':
      if (input.baseUnapproved) {
        return wait(
          'agent',
          writer,
          say('designs.act.repin'),
          say('designs.rule.baseUnapproved', {
            code: input.baseUnapproved.code,
            detail: input.baseUnapproved.detail,
          }),
        );
      }
      return proposedWait(input, input.proposedRevision ?? latest ?? 1);
    case 'returned':
      return wait(
        'agent',
        say('standing.who.projectMaster'),
        latest === null ? say('designs.act.revise') : say('designs.act.reviseR', { r: latest }),
        say('designs.rule.returned'),
      );
    case 'draft':
      return wait('agent', writer, say('designs.act.finish'), say('designs.rule.draft'));
    case 'approved':
      return wait(
        'none',
        NOBODY,
        NO_ACT,
        say('designs.rule.approved', { r: input.approvedRevision ?? latest ?? 1 }),
      );
    default:
      return wait('none', NOBODY, NO_ACT, say('designs.rule.notUnderApproval'));
  }
}

// An approved design with a newer revision proposed still reads as approved on the list; the
// newer revision is named as pending until its approver decides it
export function designListReadingOf(
  input: DesignStandingInput,
  revision: number,
): DesignListReading {
  const approved = input.approvedRevision;
  const pending = input.status === 'proposed' && approved !== null && revision > approved;
  return {
    shown: input.status === 'proposed' && approved !== null ? 'approved' : input.status,
    pendingRevision: pending ? revision : null,
    waitingOn: designWaitingOn(input),
  };
}

// The gate is `build-gate.ts:designUnapprovedSql` read for one design: an issue that builds it
// is dispatched only while its status is approved, so a newer proposal holds builds again
export function buildGateOf(head: DesignHeadFacts): DesignBuildGate {
  const gate = (open: boolean, rule: Said): DesignBuildGate => ({
    open,
    rule: sayEn(rule),
    says: { rule },
  });
  if (head.status === 'approved') {
    return gate(true, say('designs.gate.open', { r: String(head.approvedRevision ?? '?') }));
  }
  const why =
    head.status === null
      ? say('designs.gate.noApproval')
      : head.status === 'proposed'
        ? say('designs.gate.waitsApprover', { r: String(head.proposedRevision ?? '?') })
        : say('designs.gate.status', { status: head.status });
  return gate(false, say('designs.gate.held', { why }));
}

/** The revision a build was linked against: the newest approval decided at or before the link,
 *  null where none was. Decisions are rows that are never rewritten, so their times are the record. */
export function builtAgainstOf(
  linkedAt: Date,
  designs: readonly { revision: number; decision: string | null; decidedAt: Date | null }[],
): number | null {
  const approved = designs.filter(
    (d) => d.decision === 'approve' && d.decidedAt !== null && d.decidedAt <= linkedAt,
  );
  return approved.length === 0 ? null : Math.max(...approved.map((d) => d.revision));
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
