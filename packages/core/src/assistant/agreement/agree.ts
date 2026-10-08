// Agreeing to a held chat write (workflow chat-turn step confirm, edge "agrees"). One way counts: the
// person it waits on presses Record it on the confirm card, as themselves. What anybody typed in the
// chat is never an agreement, whatever it says: core has no rule for reading assent in free text, and
// a model that judged it wrote a requirement the person had refused (ISS-439, the judge's probe A).
// Then the held call is written as them, once.

import type { ChatProposalRefusalCode } from '@forge/contracts/chat-proposals';
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

/** The person pressing the card, and the authority their press writes under. */
export interface AgreeAs {
  userId: string;
  authority: TurnAuthority;
}

/** The proposal `id`, as `userId` may decide it, or the refusal naming why not. */
async function decidable(id: string, userId: string) {
  const row = await readProposal(id);
  if (!row) {
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

/** Agree to proposal `id` and write it; the settled row and what the write made or why it failed. */
export async function agreeProposal(
  id: string,
  as: AgreeAs,
): Promise<{ row: ChatProposalRow; outcome: WriteOutcome }> {
  const row = await decidable(id, as.userId);
  const claimed = await claimAgreement(row.id, as.userId);
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
  await decidable(id, userId);
  const row = await declineProposal(id, userId);
  if (!row) {
    throw refuse(
      'CHAT_PROPOSAL_SETTLED',
      `proposal ${id} was decided while this was on its way; nothing more is changed`,
    );
  }
  return row;
}
