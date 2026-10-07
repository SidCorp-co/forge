import type {
  RequirementAttentionGroup,
  RequirementWaitingKind,
} from '@forge/contracts/requirements';
import { type Said, say } from '@forge/contracts/said';
import { type WaitingOn, waitingOn } from '@forge/contracts/standing';
import type { RevisionState } from '../db/schema-requirements.js';

export interface StandingRevision {
  revision: number;
  state: RevisionState;
  authorId: string;
  authorName: string | null;
  authorKind: 'human' | 'agent';
  authorAgency: 'human' | 'agent';
  createdAt: Date;
  proposedAt: Date | null;
  decidedAt: Date | null;
  /** Its signer returned it to draft with a reason (`requirement_revisions.return_reason`). */
  returned?: boolean;
}

const RULE = say('requirements.rule.draftAuthor');

const turn = (
  group: RequirementAttentionGroup,
  kind: RequirementWaitingKind,
  who: Said,
  act: Said,
  rule: Said,
): { group: RequirementAttentionGroup; waitingOn: WaitingOn<RequirementWaitingKind> } => ({
  group,
  waitingOn: waitingOn(kind, { who, act, rule }),
});

/** Whose turn an open draft revision is: an agent's draft is its master's to propose or drop,
 *  whichever account the agent wrote it under; a person's draft is its author's. */
export function draftTurn(draft: StandingRevision, viewer: { userId: string } | null) {
  const returned = draft.returned === true;
  const r = draft.revision;
  if (draft.authorAgency === 'agent') {
    return turn(
      'waiting',
      'agent',
      say('standing.who.master'),
      returned
        ? say('standing.act.reviseThenProposeOrDrop', { r })
        : say('standing.act.proposeOrDrop', { r }),
      say(returned ? 'requirements.rule.agentReturned' : 'requirements.rule.agentDraft'),
    );
  }
  if (viewer && draft.authorId === viewer.userId) {
    return turn(
      'needs_you',
      'you',
      say('standing.who.you'),
      returned ? say('standing.act.reviseReturned', { r }) : say('standing.act.proposeR', { r }),
      RULE,
    );
  }
  const kind = draft.authorKind === 'agent' ? 'agent' : 'person';
  return turn(
    'waiting',
    kind,
    draft.authorName
      ? say('standing.who.named', { name: draft.authorName })
      : say('standing.who.itsAuthor'),
    say('standing.act.finishDraft'),
    RULE,
  );
}

// An agree is refused while a linked design holds no approved revision, so until each is approved
// the requirement waits on the designs: on the master while one is not yet proposed, else on whoever
// approves designs (FB-73: it read "You · agree" and the agree was refused)
export function designTurn(
  unapproved: readonly { flow: string; title: string; designStatus: string | null }[],
  head: number | null,
) {
  if (unapproved.length === 0) return null;
  const rule =
    head === null
      ? say('requirements.rule.designsFirst')
      : say('requirements.rule.designsFirstR', { r: head });
  const flows = (list: typeof unapproved) => list.map((d) => d.title).join(', ');
  const unproposed = unapproved.filter((d) => d.designStatus !== 'proposed');
  if (unproposed.length > 0) {
    return turn(
      'waiting',
      'agent',
      say('standing.who.master'),
      say('standing.act.proposeDesign', { what: flows(unproposed) }),
      rule,
    );
  }
  return turn(
    'waiting',
    'person',
    say('standing.who.holderOf', { perm: 'workflow-designs.approve' }),
    say('standing.act.approveDesign', { what: flows(unapproved) }),
    rule,
  );
}
