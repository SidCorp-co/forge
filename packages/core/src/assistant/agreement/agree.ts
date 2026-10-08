// Agreeing to a held chat write (workflow chat-turn step confirm, edge "agrees"). Two ways count:
// the person presses the confirm card, as themselves; or a chat turn binds the person's reply to the
// proposal, and that binding is checked here rather than trusted: the proposal waits on the person
// the turn answers, in the same conversation, was made before they replied, is of the kind named,
// and the words quoted are their whole message. Then the held call is written as them, once.

import {
  CHAT_PROPOSAL_KINDS,
  type ChatProposalKind,
  type ChatProposalRefusalCode,
} from '@forge/contracts/chat-proposals';
import type { TurnAuthority } from '../../credentials/turn-credential.js';
import { logger } from '../../lib/logger.js';
import { isRefusal, refuser } from '../../lib/refusal.js';
import { type WriteOutcome, writeAgreed } from './execute.js';
import {
  type ChatProposalRow,
  claimAgreement,
  declineProposal,
  readProposal,
  settleProposal,
} from './store.js';

const refuse = refuser<ChatProposalRefusalCode>('CHAT_PROPOSAL_UNKNOWN');

/** The reply a chat turn binds, and the facts the binding is checked against. */
export interface BoundReply {
  conversationId: string;
  /** The person's message that started the turn, as the turn read it. */
  message: string;
  /** When that turn started: a proposal made after it is one the person has not seen. */
  startedAt: Date;
  words: string;
  kind: ChatProposalKind;
}

export type AgreeAs =
  | { via: 'card'; userId: string; authority: TurnAuthority }
  | { via: 'reply'; userId: string; authority: TurnAuthority; reply: BoundReply };

/** Two texts are the same message when they differ only in case and spacing. */
const sameMessage = (a: string, b: string): boolean => {
  const norm = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(a).length > 0 && norm(a) === norm(b);
};

/** The proposal `id`, as `userId` may decide it, or the refusal naming why not. */
async function decidable(id: string, userId: string, conversationId: string | null) {
  const row = await readProposal(id);
  if (!row || (conversationId !== null && row.conversationId !== conversationId)) {
    throw refuse(
      'CHAT_PROPOSAL_UNKNOWN',
      `proposal ${id} is not one made in this conversation; the proposals waiting are read with GET /api/conversations/<id>/proposals`,
      '/proposal',
    );
  }
  if (row.proposedTo !== userId) {
    throw refuse(
      'CHAT_PROPOSAL_NOT_YOURS',
      `proposal ${id} waits on the person the chat answered when it proposed it, and only they agree or decline it`,
    );
  }
  if (row.status !== 'pending') {
    throw refuse(
      'CHAT_PROPOSAL_SETTLED',
      `proposal ${id} is ${row.status} already; a proposal is decided once, and nothing more is written`,
    );
  }
  return row;
}

function checkBinding(row: ChatProposalRow, reply: BoundReply): void {
  if (row.createdAt >= reply.startedAt) {
    throw refuse(
      'CHAT_AGREEMENT_UNBOUND',
      `proposal ${row.id} was made in this same turn, so the person has not seen it yet: a reply agrees only to a proposal shown before they wrote it. Ask for their go-ahead and end the turn.`,
      '/proposal',
    );
  }
  if (reply.kind !== row.kind) {
    throw refuse(
      'CHAT_AGREEMENT_UNBOUND',
      `proposal ${row.id} would write ${row.kind}, not ${reply.kind}: an agreement names the kind of the record it agrees to (${CHAT_PROPOSAL_KINDS.join(', ')})`,
      '/kind',
    );
  }
  if (!sameMessage(reply.words, reply.message)) {
    throw refuse(
      'CHAT_AGREEMENT_UNBOUND',
      'words must be the whole message the person sent, quoted as they wrote it: an agreement is their reply, never a part of it or a paraphrase. If that message does not agree, nothing is written.',
      '/words',
    );
  }
}

/** Agree to proposal `id` and write it; the settled row and what the write made or why it failed. */
export async function agreeProposal(
  id: string,
  as: AgreeAs,
): Promise<{ row: ChatProposalRow; outcome: WriteOutcome }> {
  const row = await decidable(id, as.userId, as.via === 'reply' ? as.reply.conversationId : null);
  if (as.via === 'reply') checkBinding(row, as.reply);
  const words = as.via === 'reply' ? as.reply.words : null;
  const claimed = await claimAgreement(row.id, as.userId, as.via, words);
  if (!claimed) {
    throw refuse(
      'CHAT_PROPOSAL_SETTLED',
      `proposal ${id} was decided while this agreement was on its way; nothing more is written`,
    );
  }
  let outcome: WriteOutcome;
  try {
    outcome = await writeAgreed(claimed, as.authority);
  } catch (err) {
    // a write that broke is settled as failed, never left reading "agreed" with nothing behind it
    if (!isRefusal(err)) logger.error({ err, proposalId: id }, 'chat agreement: the write broke');
    const why = err instanceof Error ? err.message : String(err);
    outcome = { ok: false, failure: isRefusal(err) ? why : `the write did not complete: ${why}` };
  }
  const settled = await settleProposal(
    claimed.id,
    outcome.ok ? { ok: true, record: outcome.record } : outcome,
  );
  return { row: settled, outcome };
}

export async function declineAs(id: string, userId: string): Promise<ChatProposalRow> {
  await decidable(id, userId, null);
  const row = await declineProposal(id, userId);
  if (!row) {
    throw refuse(
      'CHAT_PROPOSAL_SETTLED',
      `proposal ${id} was decided while this was on its way; nothing more is changed`,
    );
  }
  return row;
}
