import type {
  RequirementAttentionGroup,
  RequirementWaitingKind,
} from '@forge/contracts/requirements';
import type { WaitingOn } from '@forge/contracts/standing';
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

const RULE = 'an open draft revision waits on its author to propose it';

const turn = (
  group: RequirementAttentionGroup,
  kind: RequirementWaitingKind,
  who: string,
  act: string,
  rule: string,
): { group: RequirementAttentionGroup; waitingOn: WaitingOn<RequirementWaitingKind> } => ({
  group,
  waitingOn: { kind, who, act, rule, ref: null, dueAt: null },
});

/** Whose turn an open draft revision is: an agent's draft is its master's to propose or drop,
 *  whichever account the agent wrote it under; a person's draft is its author's. */
export function draftTurn(draft: StandingRevision, viewer: { userId: string } | null) {
  const returned = draft.returned === true;
  if (draft.authorAgency === 'agent') {
    return turn(
      'waiting',
      'agent',
      'Master',
      returned
        ? `revise returned r${draft.revision}, then propose or drop it`
        : `propose or drop r${draft.revision}`,
      returned
        ? 'its signer returned this agent-written revision with a reason, so the master that runs that agent revises it: core wakes it on the return and its box carries the return to every pass until it is proposed or dropped'
        : 'an agent wrote this draft, under whichever account it is paired with, so the master that runs it proposes or drops it',
    );
  }
  if (viewer && draft.authorId === viewer.userId) {
    return turn(
      'needs_you',
      'you',
      'You',
      returned ? `revise returned r${draft.revision}` : `propose r${draft.revision}`,
      RULE,
    );
  }
  const kind = draft.authorKind === 'agent' ? 'agent' : 'person';
  return turn('waiting', kind, draft.authorName ?? 'Its author', 'finish draft', RULE);
}

// An agree is refused while a linked design holds no approved revision, so until each is approved
// the requirement waits on the designs: on the master while one is not yet proposed, else on whoever
// approves designs (FB-73: it read "You · agree" and the agree was refused)
export function designTurn(
  unapproved: readonly { flow: string; designStatus: string | null }[],
  head: number | null,
) {
  if (unapproved.length === 0) return null;
  const rule = `every linked design is approved before the agree pins it (REQUIREMENT_DESIGN_UNAPPROVED); then a signer agrees ${head === null ? 'it' : `r${head}`}`;
  const flows = (list: typeof unapproved) => list.map((d) => d.flow).join(', ');
  const unproposed = unapproved.filter((d) => d.designStatus !== 'proposed');
  if (unproposed.length > 0) {
    return turn('waiting', 'agent', 'Master', `propose design ${flows(unproposed)}`, rule);
  }
  return turn(
    'waiting',
    'person',
    'A holder of workflow-designs.approve',
    `approve design ${flows(unapproved)}`,
    rule,
  );
}
