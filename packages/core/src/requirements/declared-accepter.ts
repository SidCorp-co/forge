// Who decided a requirement revision, as its row and its baseline record it (REQ-90 BC-15, ISS-1436):
// the signer's user, or a speaker a project admin declared by chat identity for `accept`, by that
// identity's account and the name the room showed (`declared-accept.ts`).

import type { RequirementActor } from './read.js';

/**
 * Who accepted a revision by a project's declaration of their chat identity: the identity's account
 * (null where it is linked and holds none) and the name the room showed, and the Forge user it is
 * linked to (null where it holds none). The declaration is its caller's to read: no signer is asked.
 */
export interface DeclaredAccepter {
  chatAccountId: string | null;
  name: string;
  userId: string | null;
}

/** The columns naming who decided: the actor's user, or the declared speaker's identity. */
export function accepterColumns(actor: RequirementActor, declared: DeclaredAccepter | undefined) {
  if (!declared) {
    return { decidedBy: actor.userId, decidedByChatAccount: null, decidedByChatName: null };
  }
  if (!declared.chatAccountId && !declared.userId) {
    throw new Error('requirements: a declared accepter names neither a chat identity nor a user');
  }
  return {
    decidedBy: declared.userId,
    decidedByChatAccount: declared.chatAccountId,
    decidedByChatName: declared.chatAccountId ? declared.name : null,
  };
}

/** The same, as a baseline names who agreed it. */
export function agreerColumns(actor: RequirementActor, declared: DeclaredAccepter | undefined) {
  const c = accepterColumns(actor, declared);
  return {
    agreedBy: c.decidedBy,
    agreedByChatAccount: c.decidedByChatAccount,
    agreedByChatName: c.decidedByChatName,
  };
}
