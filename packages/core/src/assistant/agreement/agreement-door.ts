// Who an agreement arrives from, read from the credential: only the person's own sign-in or token
// presses a card. No chat credential agrees or declines — not the assistant's turn token, not an
// Agent session's, not the token an agreed proposal is written under — whatever the person typed in
// the chat, since a typed reply is never an agreement (REQ-30 BC-4, workflow chat-turn step confirm).

import type { ChatProposalRefusalCode } from '@forge/contracts/chat-proposals';
import { chatDoorOfToken } from '../../agent-sessions/index.js';
import { readableConversation } from '../../conversations/index.js';
import { currentPatScope } from '../../credentials/pat-scope.js';
import { RefusalError, refuser } from '../../lib/refusal.js';
import { resolveTurnAuthority } from '../../permissions/index.js';
import type { AgreeAs } from './agree.js';
import type { ChatProposalRow } from './store.js';

const refuse = refuser<ChatProposalRefusalCode>('CHAT_AGREEMENT_DOOR');

async function authorityOf(userId: string, projectId: string, viaTokenId: string | null) {
  const resolved = await resolveTurnAuthority({ userId, projectId, viaTokenId });
  if (!resolved.ok) {
    const { code, message } = resolved.refusal;
    throw new RefusalError([{ code, path: '', detail: message }], code);
  }
  return resolved.authority;
}

/** Refused when the request arrived on a chat credential: a proposal is decided by the person's own press. */
async function refuseChatCredential(act: 'agreed' | 'declined'): Promise<void> {
  const scope = currentPatScope();
  if (!scope || !(await chatDoorOfToken(scope.tokenId))) return;
  throw refuse(
    'CHAT_AGREEMENT_DOOR',
    act === 'agreed'
      ? 'a proposal is agreed only by the person it waits on pressing Record it on its card, from their own sign-in. A chat credential agrees to nothing, whatever the person typed: tell them the card is waiting. Nothing was written.'
      : 'a proposal is declined by the person it waits on, from their own sign-in; a chat that hears "no" writes nothing and leaves the card to them',
  );
}

/** The person pressing Record it, and the authority their press writes under. */
export async function agreementOf(
  conversationId: string,
  proposal: ChatProposalRow,
  userId: string,
): Promise<AgreeAs> {
  await refuseChatCredential('agreed');
  await readableConversation(conversationId, userId);
  const scope = currentPatScope();
  return {
    userId,
    authority: await authorityOf(userId, proposal.projectId, scope?.tokenId ?? null),
  };
}

/** A decline is the person's own, from their sign-in: refused on any chat credential. */
export function refuseChatDecline(): Promise<void> {
  return refuseChatCredential('declined');
}
