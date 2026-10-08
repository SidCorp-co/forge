// The held chat writes (`chat_proposals`): recorded when a chat's write is refused for want of an
// agreement, decided once by the person it waits on. Every decision is one guarded UPDATE from
// `pending`, so a second press, or a decline racing an agreement, leaves exactly one of them
// standing and refuses the other by name.

import type {
  ChatProposalForm,
  ChatProposalKind,
  ChatProposalRecord,
  ChatProposalSummary,
} from '@forge/contracts/chat-proposals';
import { and, asc, eq } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import { type ChatProposalRow, chatProposals } from '../../db/schema-chat-proposals.js';

export type { ChatProposalRow };

/** An Assistant tool call as held: the tool, its arguments, and the images the turn's record carries. */
export interface HeldToolCall {
  name: string;
  arguments: string;
  images?: { name: string; mime: string; ref: string; dataBase64: string }[];
}

/** An Agent session's REST request as held; its bytes are the row's `body`. */
export interface HeldRestCall {
  method: string;
  path: string;
  contentType: string | null;
  /** The headers that change what the route does (a client's declared capabilities), as sent. */
  headers?: Record<string, string>;
}

export interface NewProposal {
  projectId: string;
  conversationId: string;
  proposedTo: string;
  handleUserId: string | null;
  sessionId: string | null;
  kind: ChatProposalKind;
  form: ChatProposalForm;
  call: HeldToolCall | HeldRestCall;
  body: Buffer | null;
  summary: ChatProposalSummary;
}

export async function recordProposal(p: NewProposal): Promise<ChatProposalRow> {
  const [row] = await db
    .insert(chatProposals)
    .values({ ...p, createdAt: new Date() })
    .returning();
  if (!row) throw new Error('chat agreement: the proposal was not stored');
  return row;
}

/** Replace what a proposal holds, while the turn that made it is still writing its reply. */
export async function restateProposal(
  id: string,
  call: HeldToolCall,
  summary: ChatProposalSummary,
): Promise<void> {
  await db
    .update(chatProposals)
    .set({ call, summary })
    .where(and(eq(chatProposals.id, id), eq(chatProposals.status, 'pending')));
}

export async function readProposal(id: string): Promise<ChatProposalRow | null> {
  const [row] = await db.select().from(chatProposals).where(eq(chatProposals.id, id)).limit(1);
  return row ?? null;
}

export function listProposals(conversationId: string): Promise<ChatProposalRow[]> {
  return db
    .select()
    .from(chatProposals)
    .where(eq(chatProposals.conversationId, conversationId))
    .orderBy(asc(chatProposals.createdAt));
}

/**
 * The records this conversation wrote through an agreement, oldest first: what a reply's claim to
 * have recorded something is held to (`messaging/creation-claims-rule.ts`).
 */
export async function recordedIn(
  conversationId: string,
  tx: Tx = db,
): Promise<{ kind: ChatProposalKind; ref: string | null }[]> {
  const rows = await tx
    .select({ kind: chatProposals.kind, record: chatProposals.record })
    .from(chatProposals)
    .where(
      and(eq(chatProposals.conversationId, conversationId), eq(chatProposals.status, 'recorded')),
    )
    .orderBy(asc(chatProposals.createdAt));
  return rows.map((r) => ({
    kind: r.kind,
    ref: (r.record as ChatProposalRecord | null)?.ref ?? null,
  }));
}

/** Take the person's press on the card: the row it moved, or null when it no longer waited. */
export async function claimAgreement(id: string, by: string): Promise<ChatProposalRow | null> {
  const [row] = await db
    .update(chatProposals)
    .set({
      status: 'agreed',
      agreedVia: 'card',
      decidedBy: by,
      decidedAt: new Date(),
    })
    .where(and(eq(chatProposals.id, id), eq(chatProposals.status, 'pending')))
    .returning();
  return row ?? null;
}

export async function declineProposal(id: string, by: string): Promise<ChatProposalRow | null> {
  const [row] = await db
    .update(chatProposals)
    .set({ status: 'declined', decidedBy: by, decidedAt: new Date() })
    .where(and(eq(chatProposals.id, id), eq(chatProposals.status, 'pending')))
    .returning();
  return row ?? null;
}

/** What the agreed write made, or why it was refused. */
export async function settleProposal(
  id: string,
  outcome: { ok: true; record: ChatProposalRecord } | { ok: false; failure: string },
): Promise<ChatProposalRow> {
  const [row] = await db
    .update(chatProposals)
    .set(
      outcome.ok
        ? { status: 'recorded', record: outcome.record }
        : { status: 'failed', failure: outcome.failure },
    )
    .where(and(eq(chatProposals.id, id), eq(chatProposals.status, 'agreed')))
    .returning();
  if (!row) throw new Error(`chat agreement: proposal ${id} was not being written when it settled`);
  return row;
}
