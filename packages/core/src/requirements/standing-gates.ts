/**
 * Whose act a requirement's turn is, and the step after it (REQ-34 BC-19, BC-22; Requirement
 * lifecycle r15). A step a project switch gates (`@forge/contracts/person-gates`) is asked of the
 * holders of its approve permission where the switch is on, and of the requirement's owner where it
 * is off, so a person's Needs you lists only what that person must do. Pure, like `standing.ts`,
 * whose turn reads it.
 */

import { type PersonGate, personGateOn } from '@forge/contracts/person-gates';
import type {
  RequirementState,
  RequirementWaitingKind,
  RequirementWaitingOn,
} from '@forge/contracts/requirements';
import { type Said, say } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import type { StandingInput } from './standing.js';

const YOU = say('standing.who.you');
const MASTER = say('standing.who.master');
const SIGNER = say('standing.who.baOrOwner');

const wait = (
  kind: RequirementWaitingKind,
  who: Said,
  act: Said,
  rule: Said,
  dueAt: string | null = null,
): RequirementWaitingOn => waitingOn(kind, { who, act, rule }, { dueAt });

/**
 * The step after `state`, each step's Next: in Requirement lifecycle r15 (REQ-34 BC-19): Draft, then
 * Agreed (through Waiting for agreement where the setting asks), the breakdown and In delivery,
 * Delivered, Accepted, and nothing after. Deferred goes back to the step it left: Agreed where its
 * head was agreed (a deferral from Agreed keeps its baseline), else Draft.
 */
export function nextStepOf(
  state: RequirementState,
  agreedAt: Date | null,
): RequirementState | null {
  switch (state) {
    case 'draft':
      return 'agreed';
    case 'agreed':
      return 'in_delivery';
    case 'in_delivery':
      return 'delivered';
    case 'delivered':
      return 'accepted';
    case 'deferred':
      return agreedAt === null ? 'draft' : 'agreed';
    case 'accepted':
    case 'dropped':
      return null;
  }
}

/** An approval no project switch gates (a triage, a merge-or-drop answer, a suggested revision's
 *  accept): every holder of requirements.approve may do it, so each of them is asked. A draft
 *  issue's promote is asked of a signer who holds issues.admit whatever the switch, in `standing.ts`
 *  (`promote-drafts.ts`, question 3b8292dc). */
export const signerWait = (viewer: StandingInput['viewer'], act: Said, rule: Said) =>
  viewer?.canSignOff
    ? { group: 'needs_you' as const, waitingOn: wait('you', YOU, act, rule) }
    : { group: 'waiting' as const, waitingOn: wait('person', SIGNER, act, rule) };

/** The steps a project switch gates on a requirement's own turn (`@forge/contracts/person-gates`). */
type TurnGate = Extract<PersonGate, 'agree' | 'revisions' | 'accept' | 'breakdown'>;

/** Who the act falls to where a step's switch is on: the holders of its approve permission. */
const GATE_HOLDER: Record<
  TurnGate,
  { holds: (v: NonNullable<StandingInput['viewer']>) => boolean; who: Said }
> = {
  agree: { holds: (v) => v.canSignOff, who: SIGNER },
  revisions: { holds: (v) => v.canSignOff, who: SIGNER },
  accept: { holds: (v) => v.canSignOff, who: SIGNER },
  breakdown: {
    holds: (v) => v.canApproveBreakdown === true,
    who: say('standing.who.holderOf', { perm: 'suggestions.approve' }),
  },
};

/**
 * Whose act a gated step is, so a person's Needs you lists only what they must do (REQ-34 BC-22).
 * Where the project asks a person at this step (its `approvals` switch is on), every holder of the
 * step's approve permission may do it, and only they are asked. Where it does not, the move asks only
 * the write permission (`person-gates.ts:PERSON_GATE_STEPS`), so it is the requirement's owner's: a
 * holder of the approve permission who is not its owner is not asked, and an agent owner's act is
 * its master's.
 */
export function actWait(
  input: StandingInput,
  gate: TurnGate,
  act: Said,
  rule: Said,
  /** When the act falls due, and whom a switched-on step names where the viewer may not take it. */
  more: { dueAt?: string | null; holder?: Said } = {},
) {
  const { viewer, owner } = input;
  const due = more.dueAt ?? null;
  if (personGateOn(input.approvals, gate)) {
    const holder = GATE_HOLDER[gate];
    return viewer && holder.holds(viewer)
      ? { group: 'needs_you' as const, waitingOn: wait('you', YOU, act, rule, due) }
      : {
          group: 'waiting' as const,
          waitingOn: wait('person', more.holder ?? holder.who, act, rule, due),
        };
  }
  if (owner?.kind === 'agent') {
    return { group: 'waiting' as const, waitingOn: wait('agent', MASTER, act, rule, due) };
  }
  if (owner && viewer?.userId === owner.id) {
    return { group: 'needs_you' as const, waitingOn: wait('you', YOU, act, rule, due) };
  }
  const named = owner?.name ? say('standing.who.named', { name: owner.name }) : SIGNER;
  return { group: 'waiting' as const, waitingOn: wait('person', named, act, rule, due) };
}
