import { type DesignOwed, owedWait } from '@forge/contracts/design-owed';
import type { DesignRevisionState, DesignStatus } from '@forge/contracts/design-status';
import { type Said, say, sayEn } from '@forge/contracts/said';
import { type WaitingOn, waitingOn } from '@forge/contracts/standing';
import { type OwedPolicy, whoOwes } from '@forge/contracts/who-owes';
import type {
  DesignBaseFault,
  DesignBuildGate,
  DesignListReading,
  DesignWaitingKind,
} from '@forge/contracts/workflows';
import type { DesignDecision } from './design.js';

type DesignWaitingOn = WaitingOn<DesignWaitingKind>;

/**
 * Whether the project's master decides its proposed designs (ISS-1158): the one rule's
 * `design.decide` over the project's policy, which names a person only on a strict project or where
 * the designs gate asks one. Where it names the master the project is not strict, so the master holds
 * workflow-designs.approve there (`permissions/master-acts.ts:actsAsMaster`): the read never names a
 * master its door would refuse. The pass and every design read ask this, never the profile alone.
 */
export const masterDecidesDesigns = (policy: OwedPolicy): boolean =>
  whoOwes('design.decide', policy).by === 'master';

interface DesignHeadFacts {
  status: DesignStatus | null;
  proposedRevision: number | null;
  approvedRevision: number | null;
}

interface DesignStandingInput extends DesignHeadFacts {
  latest: { revision: number; author: string | null } | null;
  canDecide: boolean;
  /**
   * Whether the project's master decides its designs (`masterDecidesDesigns`): then a
   * proposal waits on the master, whoever reads it, and its pass names it (ISS-1158).
   */
  masterDecides: boolean;
  /**
   * What the design owes a person past its step, as Needs you lists it (`@forge/contracts/design-owed`):
   * where its step owes nobody, this is what it waits on. Left out where the reader does not read it.
   */
  owed?: DesignOwed | null;
  /** The refusal approving the proposed revision would meet on its bases now (`standingBaseRefusal`). */
  baseUnapproved?: { revision: number; bases: readonly DesignBaseFault[] } | null;
}

const wait = (kind: DesignWaitingKind, who: Said, act: Said, rule: Said): DesignWaitingOn =>
  waitingOn(kind, { who, act, rule });

const NOBODY = say('standing.who.nobody');
const NO_ACT = say('standing.act.none');

/**
 * A decision only the design approver takes: the project's master where it decides designs, else you
 * where you may take it, else whoever holds approval.
 */
const approverWait = (input: DesignStandingInput, act: Said, rule: Said): DesignWaitingOn => {
  if (input.masterDecides) return wait('agent', say('standing.who.projectMaster'), act, rule);
  return input.canDecide
    ? wait('you', say('standing.who.you'), act, rule)
    : wait('person', say('standing.who.holderOf', { perm: 'workflow-designs.approve' }), act, rule);
};

function proposedWait(input: DesignStandingInput): DesignWaitingOn {
  const rule = input.masterDecides
    ? say('designs.rule.masterDecides')
    : input.canDecide
      ? say('designs.rule.youDecide')
      : say('designs.rule.approverDecides');
  return approverWait(input, say('designs.act.approveOrReturn'), rule);
}

// Every base the proposed revision waits on is proposed at the pinned revision: approving those
// bases is the next act, the approver's, and the writer owes no re-pin (FB-145)
function baseApprovalWait(
  input: DesignStandingInput,
  blocked: NonNullable<DesignStandingInput['baseUnapproved']>,
): DesignWaitingOn | null {
  if (!blocked.bases.every((b) => b.state === 'proposed')) return null;
  return approverWait(
    input,
    say('designs.act.approveBase'),
    say('designs.rule.baseAwaitsApproval'),
  );
}

// Whose turn a design is, first rule wins: proposed on a base proposed at its pin → the base's
// approver; proposed on a base it must be re-pinned off → its writer; proposed → its approver (the
// project's master where it decides designs, else you when you may decide); returned → the project's master, which `owed-designs.ts` carries it to; draft → the writer drawing
// it; approved, withdrawn or not under approval → nobody, unless it owes a person past its step: the
// pin-only changes its approval left, or places its code and design differ (`owedWait`), the wait
// Needs you lists on it, so the page never says nothing is next while Needs you counts what is owed
export function designWaitingOn(input: DesignStandingInput): DesignWaitingOn {
  const step = stepWaitingOn(input);
  if (step.kind !== 'none' || !input.owed) return step;
  return owedWait(input.owed, input.canDecide) ?? step;
}

/** Whose turn the design's own step is, first rule wins (above). */
function stepWaitingOn(input: DesignStandingInput): DesignWaitingOn {
  const latest = input.latest?.revision ?? null;
  const author = input.latest?.author;
  const writer = author ? say('standing.who.named', { name: author }) : say('standing.who.master');
  switch (input.status) {
    case 'proposed':
      if (input.baseUnapproved) {
        const onBase = baseApprovalWait(input, input.baseUnapproved);
        if (onBase) return onBase;
        return wait(
          'agent',
          writer,
          say('designs.act.repin'),
          say('designs.rule.baseUnapprovedAt'),
        );
      }
      return proposedWait(input);
    case 'returned':
      return wait(
        'agent',
        say('standing.who.projectMaster'),
        latest === null ? say('designs.act.revise') : say('designs.act.reviseR'),
        say('designs.rule.returned'),
      );
    case 'draft':
      return wait('agent', writer, say('designs.act.finish'), say('designs.rule.draft'));
    case 'approved':
      return wait('none', NOBODY, NO_ACT, say('designs.rule.approved'));
    case 'withdrawn':
      return wait('none', NOBODY, NO_ACT, say('designs.rule.withdrawn'));
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
    return gate(true, say('designs.gate.open'));
  }
  const why =
    head.status === null
      ? say('designs.gate.noApproval')
      : head.status === 'proposed'
        ? say('designs.gate.waitsApprover')
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
