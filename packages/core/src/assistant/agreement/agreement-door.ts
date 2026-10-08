// Who an agreement arrives from, read from the credential: the person's own sign-in or token
// presses a card; an Agent-mode session binds the person's reply to the turn it answers; any other
// chat credential agrees to nothing, and no chat credential declines.

import type {
  agreeChatProposalRequestSchema,
  ChatProposalRefusalCode,
} from '@forge/contracts/chat-proposals';
import type { z } from 'zod';
import { chatDoorOfToken } from '../../agent-sessions/index.js';
import { agentTurnOfSession, readableConversation } from '../../conversations/index.js';
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

/** How the agreement arrived: the person's own sign-in or token (a card), or a session binding their reply. */
export async function agreementOf(
  conversationId: string,
  proposal: ChatProposalRow,
  userId: string,
  body: z.infer<typeof agreeChatProposalRequestSchema>,
): Promise<AgreeAs> {
  const scope = currentPatScope();
  const door = scope ? await chatDoorOfToken(scope.tokenId) : null;
  if (!door) {
    await readableConversation(conversationId, userId);
    return {
      via: 'card',
      userId,
      authority: await authorityOf(userId, proposal.projectId, scope?.tokenId ?? null),
    };
  }
  if (door.door !== 'box-session') {
    throw refuse(
      'CHAT_AGREEMENT_DOOR',
      door.door === 'assistant-turn'
        ? 'the assistant binds a reply to a proposal with forge_agree, not with this route'
        : 'the token an agreed proposal is written under agrees to nothing',
    );
  }
  const read = await agentTurnOfSession(door.sessionId);
  const turn = read.found ? read.turn : null;
  if (!turn?.asker || turn.conversationId !== conversationId) {
    throw refuse(
      'CHAT_AGREEMENT_DOOR',
      'this session answers no turn of this conversation, so it has no reply of the person to bind',
    );
  }
  if (!body.words || !body.kind) {
    throw refuse(
      'CHAT_AGREEMENT_UNBOUND',
      `from a chat session an agreement is the person's reply: send words (their whole message) and kind (the proposal's kind, ${proposal.kind} here)`,
      body.words ? '/kind' : '/words',
    );
  }
  return {
    via: 'reply',
    userId: turn.asker.userId,
    authority: await authorityOf(turn.asker.userId, proposal.projectId, turn.asker.viaTokenId),
    reply: {
      conversationId,
      message: turn.question,
      startedAt: turn.startedAt,
      words: body.words,
      kind: body.kind,
    },
  };
}

/** A decline is the person's own, from their sign-in: refused on any chat credential. */
export async function refuseChatDecline(): Promise<void> {
  const scope = currentPatScope();
  if (scope && (await chatDoorOfToken(scope.tokenId))) {
    throw refuse(
      'CHAT_AGREEMENT_DOOR',
      'a proposal is declined by the person it waits on, from their own sign-in; a chat that hears "no" writes nothing',
    );
  }
}
