// What a room reads of the writes held in it: each proposal as a confirm card, named for the
// person it waits on, and whether the viewer is that person.

import type {
  ChatProposalRecord,
  ChatProposalSummary,
  ChatProposalView,
} from '@forge/contracts/chat-proposals';
import { inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import type { ChatProposalRow } from './store.js';

/** The people proposals wait on, by their display name or email. */
export async function labels(ids: readonly string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const found = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(found.map((u) => [u.id, u.displayName ?? u.email]));
}

export function viewOf(
  row: ChatProposalRow,
  viewerId: string,
  named: Map<string, string | null>,
): ChatProposalView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    kind: row.kind,
    status: row.status,
    summary: row.summary as ChatProposalSummary,
    proposedTo: { userId: row.proposedTo, label: named.get(row.proposedTo) ?? null },
    canDecide: row.status === 'pending' && row.proposedTo === viewerId,
    agreedVia: row.agreedVia ?? null,
    agreedWords: row.agreedWords ?? null,
    record: (row.record as ChatProposalRecord | null) ?? null,
    failure: row.failure ?? null,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}
