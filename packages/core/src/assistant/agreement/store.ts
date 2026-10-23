// The held chat writes (`chat_proposals`): recorded when a chat's write is refused for want of an
// agreement, decided once by the person it waits on. Every decision is one guarded UPDATE from
// `pending`, so a second press, or a decline racing an agreement, leaves exactly one of them
// standing and refuses the other by name. Every read serves only the kinds a chat holds now: a
// settled card of a settled-only kind (`SETTLED_ONLY_KINDS`, a lesson confusion from before 0522)
// is kept as history and served to nobody, since no screen shows a lesson confusion (REQ-50 BC-9).
// A pending card is always of a kind a chat holds, which the kind CHECK enforces.

import {
  CHAT_PROPOSAL_KINDS,
  type ChatProposalForm,
  type ChatProposalKind,
  type ChatProposalRecord,
  type ChatProposalSummary,
} from '@forge/contracts/chat-proposals';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import {
  chatProposals,
  type ChatProposalRow as StoredRow,
} from '../../db/schema-chat-proposals.js';

/** A card of a kind a chat holds now. */
export type ChatProposalRow = Omit<StoredRow, 'kind'> & { kind: ChatProposalKind };

const isLiveKind = (kind: string): kind is ChatProposalKind =>
  (CHAT_PROPOSAL_KINDS as readonly string[]).includes(kind);

/** The kinds a read serves. */
const LIVE = inArray(chatProposals.kind, [...CHAT_PROPOSAL_KINDS]);

/** A row a read or a guarded write returned, refused by name where its kind is settled-only. */
function live(row: StoredRow): ChatProposalRow {
  const { kind } = row;
  if (!isLiveKind(kind)) {
    throw new Error(
      `chat agreement: proposal ${row.id} is of the settled-only kind ${kind}, which no read serves`,
    );
  }
  return { ...row, kind };
}

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
  return live(row);
}

/** The proposals of `kind` in a conversation whose press failed, oldest first (REQ-41 BC-28). */
export async function failedProposalsOf(
  conversationId: string,
  kind: ChatProposalKind,
): Promise<ChatProposalRow[]> {
  const rows = await db
    .select()
    .from(chatProposals)
    .where(
      and(
        eq(chatProposals.conversationId, conversationId),
        eq(chatProposals.kind, kind),
        eq(chatProposals.status, 'failed'),
      ),
    )
    .orderBy(asc(chatProposals.createdAt));
  return rows.map(live);
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

/** One card, or null where none is stored or it is of a settled-only kind no read serves. */
export async function readProposal(id: string): Promise<ChatProposalRow | null> {
  const [row] = await db
    .select()
    .from(chatProposals)
    .where(and(eq(chatProposals.id, id), LIVE))
    .limit(1);
  return row ? live(row) : null;
}

export async function listProposals(conversationId: string): Promise<ChatProposalRow[]> {
  const rows = await db
    .select()
    .from(chatProposals)
    .where(and(eq(chatProposals.conversationId, conversationId), LIVE))
    .orderBy(asc(chatProposals.createdAt));
  return rows.map(live);
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
      and(
        eq(chatProposals.conversationId, conversationId),
        eq(chatProposals.status, 'recorded'),
        LIVE,
      ),
    )
    .orderBy(asc(chatProposals.createdAt));
  return rows.flatMap((r) =>
    isLiveKind(r.kind)
      ? [
          {
            kind: r.kind,
            ref: (r.record as ChatProposalRecord | null)?.ref ?? null,
          },
        ]
      : [],
  );
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
  return row ? live(row) : null;
}

export async function declineProposal(id: string, by: string): Promise<ChatProposalRow | null> {
  const [row] = await db
    .update(chatProposals)
    .set({ status: 'declined', decidedBy: by, decidedAt: new Date() })
    .where(and(eq(chatProposals.id, id), eq(chatProposals.status, 'pending')))
    .returning();
  return row ? live(row) : null;
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
  return live(row);
}
