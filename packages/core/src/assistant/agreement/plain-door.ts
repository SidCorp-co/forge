// Who writes the plain line a person decides a held proposal from (ISS-1006): the agent that proposed
// it. An Assistant turn sends it as the `plain` argument of the held call (`plain-arg.ts`); an Agent
// session, whose held REST body is replayed to a route that takes no such field, sends it here once
// its request was held. Only that session's own credential writes it, and only while the proposal
// waits: a person's press decides the proposal, and nobody else speaks for the agent that made it.

import type { ChatProposalRefusalCode } from '@forge/contracts/chat-proposals';
import { chatDoorOfToken } from '../../agent-sessions/index.js';
import { currentPatScope } from '../../credentials/pat-scope.js';
import { refuser } from '../../lib/refusal.js';
import type { ChatProposalRow } from './store.js';

const refuse = refuser<ChatProposalRefusalCode>('CHAT_PROPOSAL_NOT_YOURS');

/** Refused unless the request is the proposing session's own, and the proposal still waits. */
export async function plainWriterOf(proposal: ChatProposalRow): Promise<void> {
  const scope = currentPatScope();
  const door = scope ? await chatDoorOfToken(scope.tokenId) : null;
  if (
    door?.door !== 'box-session' ||
    !proposal.sessionId ||
    door.sessionId !== proposal.sessionId
  ) {
    throw refuse(
      'CHAT_PROPOSAL_NOT_YOURS',
      `proposal ${proposal.id}'s plain line is written by the Agent session whose request it holds, on that session's own credential; an Assistant turn sends it as the \`plain\` argument of the call it held. Nothing was written`,
    );
  }
  if (proposal.status !== 'pending') {
    throw refuse(
      'CHAT_PROPOSAL_SETTLED',
      `proposal ${proposal.id} is ${proposal.status}: its plain line is written while it waits on the person, and nothing was written`,
    );
  }
}
