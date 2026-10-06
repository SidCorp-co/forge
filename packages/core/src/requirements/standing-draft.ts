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
  if (draft.authorAgency === 'agent') {
    return turn(
      'waiting',
      'agent',
      'Master',
      `propose or drop r${draft.revision}`,
      'an agent wrote this draft, under whichever account it is paired with, so the master that runs it proposes or drops it',
    );
  }
  if (viewer && draft.authorId === viewer.userId) {
    return turn('needs_you', 'you', 'You', `propose r${draft.revision}`, RULE);
  }
  const kind = draft.authorKind === 'agent' ? 'agent' : 'person';
  return turn('waiting', kind, draft.authorName ?? 'Its author', 'finish draft', RULE);
}
