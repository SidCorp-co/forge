// The conversation itself: opening a venue, appending a turn, reading the log.
//
// Everything here is transport-neutral. What a venue IS — a Rocket.Chat room,
// a thread inside one, a browser tab — the adapter decides; this module only
// knows the pair `(adapter, externalId)` that names it and the handle that
// gives it its scope.

import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db as defaultDb } from '../db/client.js';
import type { ConversationWindowDecision } from '../db/schema-conversations.js';
import {
  type ConversationMessageRole,
  conversationMessages,
  conversations,
} from '../db/schema-conversations.js';
import type { ContentBlock } from '../lib/agent-stream-parser.js';
import { asBlocks } from './canonical-entry.js';
import type { Executor, TxOnly } from './db-executor.js';
import { resolveProjectHandle } from './handles.js';
import { attachOpeningHandle } from './participants.js';
import type { ConversationVenue } from './ports.js';
import { derivedScope } from './scope.js';

// cm:guard re-exported rather than moved out of reach: `asBlocks` is used by `toStored` below and
// `toCanonicalEntry` by every caller that had it from here, so the split is a file boundary and not
// an interface change. The definitions live in `canonical-entry.ts`.
export { asBlocks, toCanonicalEntry } from './canonical-entry.js';

// cm:guard re-exported rather than moved out of reach, for the same reason `asBlocks` is above: the
// room's own row moved to `rooms.ts` at ISS-1028 for the file's length, and a caller that imported
// `getConversation` or `renameConversation` from here still does.
export {
  type ConversationListFilter,
  countConversationsInProject,
  deleteConversation,
  effectiveConversationMode,
  getConversation,
  listConversationsInProject,
  renameConversation,
  setConversationArchived,
  settleConversationMode,
} from './rooms.js';

import { type ConversationRow, findConversation, selection } from './rooms.js';

export { type ConversationRow, findConversation };

const conflict = (message: string, code: string) =>
  new HTTPException(409, { message, cause: { code } });

export interface ConversationImage {
  name: string;
  mime: string;
  /** Absolute URL the bytes can be re-fetched from; never the bytes themselves. */
  ref: string;
}

export interface StoredConversationMessage {
  id: string;
  seq: number;
  /** The transport's own id for this message, where it had one. */
  externalId: string | null;
  role: ConversationMessageRole;
  authorUserId: string | null;
  authorLabel: string | null;
  /** The transport's own id for whoever spoke, where it named one. */
  authorKey: string | null;
  content: string;
  /** Ordered canonical blocks, or null on a row written through the text-only door. */
  blocks: ContentBlock[] | null;
  images: ConversationImage[];
  deliveryProof: unknown;
  silenceReason: string | null;
  createdAt: Date;
}

// cm:guard the venue's shape and its project are settled when it is first opened and are NOT re-decided per message: a room rebound to another project arrives here as the same `(adapter, externalId)` under a different project, and the honest answer is a refusal naming both — widening the room would answer a stranger under a scope they were never granted, and returning it unchanged would compute the answer under the wrong project's access (ISS-1001 criterion 44).
async function assertVenueMatches(
  tx: Executor,
  row: ConversationRow,
  venue: ConversationVenue,
): Promise<void> {
  if (row.shape !== venue.shape) {
    throw conflict(
      `conversation ${row.id} was opened as a ${row.shape} room and this message arrives as ${venue.shape}; a venue's shape is settled when it is first seen`,
      'CONVERSATION_SHAPE_CONFLICT',
    );
  }
  const scope = await derivedScope(row.id, tx);
  if (!scope.includes(venue.projectId)) {
    throw conflict(
      `conversation ${row.id} (${row.adapter} ${row.externalId}) is about ${scope.join(', ') || 'no project'} and this message arrives bound to project ${venue.projectId}; rebind the room deliberately rather than widening it here`,
      'CONVERSATION_PROJECT_CONFLICT',
    );
  }
}

/**
 * The conversation this venue names, opened with its handle if it is new.
 */
// cm:guard the conversation and its handle participant are ONE transaction and there is no window between them: a committed room with no handle derives an empty scope, which `scope.ts` refuses to every reader — so a two-step open would make a room nobody can read whenever the second step lost (ISS-1001 criterion 13).
// cm:guard `DO NOTHING RETURNING` returns no row when another transaction won the insert, which is why the loser re-reads rather than trusting the return: `DO UPDATE` would hand back the winner's row having already bumped it, and the loser would then add ITS handle to a room bound to somebody else's project.
export async function openConversation(
  venue: ConversationVenue,
  opts: { db?: typeof defaultDb } = {},
): Promise<ConversationRow> {
  const dbi = opts.db ?? defaultDb;

  const seen = await findConversation(venue.adapter, venue.externalId, dbi);
  if (seen) {
    await assertVenueMatches(dbi, seen, venue);
    return seen;
  }

  return dbi.transaction((tx) => openConversationIn(tx as unknown as Executor, venue));
}

/**
 * The same open, for a caller that already holds the transaction.
 */
// cm:guard the caller's transaction and not one of this module's, for a caller that has more to commit with it: a room opened deliberately with the people and agents it starts with is one act, and opening it in a transaction of its own leaves a committed room behind every refusal the membership doors make afterwards — a room nobody asked for, holding half the members they named (ISS-1011).
export async function openConversationIn(
  tx: Executor,
  venue: ConversationVenue,
): Promise<ConversationRow> {
  {
    const handle = await resolveProjectHandle(tx, venue.projectId);
    const [inserted] = await tx
      .insert(conversations)
      .values({
        adapter: venue.adapter,
        externalId: venue.externalId,
        shape: venue.shape,
        title: venue.title ?? null,
      })
      .onConflictDoNothing({ target: [conversations.adapter, conversations.externalId] })
      .returning(selection);

    if (!inserted) {
      const raced = await findConversation(venue.adapter, venue.externalId, tx);
      if (!raced) {
        throw new Error(
          `conversations: ${venue.adapter} ${venue.externalId} neither inserted nor found`,
        );
      }
      await assertVenueMatches(tx, raced, venue);
      return raced;
    }

    // cm:guard the OPENING is not a person's act and takes no actor: a room opens because a message arrived, and there is nobody yet whose roles could be checked. `addHandle`'s door check guards a handle somebody ADDS to a live room, which is the only case with an actor to check — routing the open through it refuses every first message instead, which is what this call used to do.
    await attachOpeningHandle(tx, inserted.id, handle.userId, venue.projectId);
    return inserted;
  }
}

export interface AppendMessageArgs {
  conversationId: string;
  /**
   * The row's id, where the caller must know it BEFORE the insert; the column
   * default mints one otherwise.
   */
  // cm:guard this exists so a streamed transcript entry and the row it becomes share ONE identity. the socket emits the entry as it grows, and a client keyed by `id` must reduce those frames and the final one to a single turn — with the id minted here at insert time, the growing frames carried one and the settled frame another, and a reducer saw two assistant turns for one answer (ISS-1029 review, F1, confirmed on beta: 19 frames under one id, the 20th under the row's).
  id?: string | undefined;
  role: ConversationMessageRole;
  content: string;
  authorUserId?: string | null;
  authorLabel?: string | null;
  authorKey?: string | null;
  externalId?: string | null;
  images?: readonly ConversationImage[] | undefined;
  /** Ordered canonical blocks for this row; omit on a caller that has only text. */
  blocks?: readonly ContentBlock[] | null | undefined;
  deliveryProof?: unknown;
  silenceReason?: string | null;
  db?: typeof defaultDb;
}

/** Append one turn. Every row already in the conversation is left alone. */
// cm:guard the row is locked and the sequence read inside the same transaction: two turns that each read `max(seq)` and each write it plus one lose one of the two, which is exactly what the jsonb blob did on a concurrent write and what the unique index on `(conversation_id, seq)` now refuses outright.
export async function appendMessage(args: AppendMessageArgs): Promise<StoredConversationMessage> {
  const [only] = await appendMessages({
    conversationId: args.conversationId,
    messages: [args],
    ...(args.db ? { db: args.db } : {}),
  });
  if (!only) throw new Error('conversation_messages: insert returned no row');
  return only;
}

export interface AppendMessagesArgs {
  conversationId: string;
  messages: ReadonlyArray<Omit<AppendMessageArgs, 'conversationId' | 'db'>>;
  db?: typeof defaultDb;
}

/**
 * Append a whole turn's messages, in order, as ONE write.
 */
// cm:guard all of them or none, under one lock: committing the question while the answer's insert fails leaves a transcript whose last row is a person waiting — which reads as a turn still running (ISS-1001 invariant 7).
export async function appendMessages(
  args: AppendMessagesArgs,
): Promise<StoredConversationMessage[]> {
  const dbi = args.db ?? defaultDb;
  if (args.messages.length === 0) return [];
  return dbi.transaction((tx) => appendMessagesIn(tx, args));
}

/**
 * The same append, for a caller that already holds the transaction.
 */
// cm:guard the collector needs the message and the window it belongs to committed TOGETHER: a message durable with no window is owed an answer nothing knows to give, and the only way to have both under one commit is for the append to take somebody else's transaction (ISS-1004, review F3).
export async function appendMessagesIn(
  tx: TxOnly,
  args: Omit<AppendMessagesArgs, 'db'>,
): Promise<StoredConversationMessage[]> {
  if (args.messages.length === 0) return [];
  {
    const [live] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, args.conversationId))
      .for('update')
      .limit(1);
    if (!live) {
      throw new HTTPException(404, {
        message: `no conversation ${args.conversationId} to append to`,
        cause: { code: 'NOT_FOUND' },
      });
    }

    const [top] = await tx
      .select({ seq: conversationMessages.seq })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, args.conversationId))
      .orderBy(desc(conversationMessages.seq))
      .limit(1);

    const rows = await tx
      .insert(conversationMessages)
      .values(
        args.messages.map((m, i) => ({
          conversationId: args.conversationId,
          ...(m.id ? { id: m.id } : {}),
          seq: (top?.seq ?? -1) + 1 + i,
          role: m.role,
          authorUserId: m.authorUserId ?? null,
          authorLabel: m.authorLabel ?? null,
          authorKey: m.authorKey ?? null,
          content: m.content,
          externalId: m.externalId ?? null,
          images: (m.images && m.images.length > 0 ? [...m.images] : null) as never,
          // cm:guard an EMPTY blocks array is written as null, not as `[]`: `[]` would say "this
          // turn produced nothing", which is a claim, while null says "this row carries its answer
          // in `content`" — the legacy reading `toCanonicalEntry` already answers for.
          blocks: (m.blocks && m.blocks.length > 0 ? [...m.blocks] : null) as never,
          deliveryProof: (m.deliveryProof ?? null) as never,
          silenceReason: m.silenceReason ?? null,
        })),
      )
      .returning();
    if (rows.length !== args.messages.length) {
      throw new Error('conversation_messages: insert returned fewer rows than it was given');
    }

    await tx
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, args.conversationId));

    return rows.map(toStored);
  }
}

/**
 * The messages a closed seq range holds, oldest first.
 */
// cm:guard the range is applied in SQL and BEFORE the limit, never by filtering the newest rows afterwards: a window claimed while its successor collects can have its whole contents pushed out of the newest `cap` rows, and the filter would then find nothing and close a person's question `unreachable` for good (ISS-1004, review pass 1 F4).
export async function readMessagesInRange(
  conversationId: string,
  range: {
    firstSeq: number;
    lastSeq: number;
    limit: number;
    /** Which end of the range `limit` keeps; the newest, absent. */
    // cm:guard the router asks for the OLDEST, because a window that collected more than a turn may carry is answered from its head and its tail is split off to the successor: keeping the newest here is how the first fifty messages of a busy room vanished without a row saying so (ISS-1086 criterion 10). Every other reader wants the newest and says nothing.
    order?: 'newest-first' | 'oldest-first';
  },
  tx: Executor = defaultDb,
): Promise<StoredConversationMessage[]> {
  const oldestFirst = range.order === 'oldest-first';
  const rows = await tx
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        gte(conversationMessages.seq, range.firstSeq),
        lte(conversationMessages.seq, range.lastSeq),
      ),
    )
    .orderBy(oldestFirst ? asc(conversationMessages.seq) : desc(conversationMessages.seq))
    .limit(range.limit);
  return (oldestFirst ? rows : rows.reverse()).map(toStored);
}

/** The last `limit` turns, oldest first. */
export async function readMessages(
  conversationId: string,
  limit: number,
  tx: Executor = defaultDb,
): Promise<StoredConversationMessage[]> {
  const rows = await tx
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(desc(conversationMessages.seq))
    .limit(limit);
  return rows.reverse().map(toStored);
}

/**
 * Has this conversation already been shown the reply for this delivery key?
 */
// cm:guard the key is the AT-MOST-ONCE proof and it is checked against what was DELIVERED, never against what was attempted: a window re-claimed after its holder died is owed an answer only if the room never got one, and the row carrying the key is the only evidence either way (ISS-1004 rule 2).
export async function deliveredUnderKey(
  conversationId: string,
  deliveryKey: string,
  tx: Executor = defaultDb,
): Promise<boolean> {
  return (await deliveredDecisionUnderKey(conversationId, deliveryKey, tx)) !== null;
}

/**
 * What was already delivered under this key, in the words of the decision that sent it.
 */
// cm:guard it answers the DECISION and not merely "something went", because the two are different records: a core that delivered an authority refusal and died before closing its window left the next claimant able to see a delivery and nothing to say what it was, so the window closed `answered` over a room that had been refused. `answered` is the default only because an ordinary reply writes no decision on its proof (ISS-1004 rule 4).
export async function deliveredDecisionUnderKey(
  conversationId: string,
  deliveryKey: string,
  tx: Executor = defaultDb,
): Promise<ConversationWindowDecision | null> {
  const [row] = await tx
    .select({ proof: conversationMessages.deliveryProof })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        sql`${conversationMessages.deliveryProof}->>'deliveryKey' = ${deliveryKey}`,
      ),
    )
    .limit(1);
  if (!row) return null;
  const proof = row.proof as { decision?: unknown } | null;
  return typeof proof?.decision === 'string'
    ? (proof.decision as ConversationWindowDecision)
    : 'answered';
}

export async function countMessages(
  conversationId: string,
  tx: Executor = defaultDb,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId));
  return row?.n ?? 0;
}

/**
 * The conversations one project's handle speaks in, newest first.
 *
 * Bounded by `limit`/`offset` where the caller has a page; unbounded where it
 * must authorize each row before it knows what a page contains.
 */
// cm:guard an UNBOUNDED read is deliberate and priced: a room's readability is a per-project role question this join cannot ask, so paginating first hands back a short page and a total that counts rooms the caller may not see. The set is one project's rooms — 35 across the whole fleet on 2026-09-14 — so reading them to authorize them is cheap today. When a single project's rooms reach the thousands, this becomes a keyset walk that authorizes as it goes, and the condition that says so is this sentence (ISS-1001 criterion 10).

function toStored(row: typeof conversationMessages.$inferSelect): StoredConversationMessage {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    authorUserId: row.authorUserId,
    authorLabel: row.authorLabel,
    authorKey: row.authorKey,
    content: row.content,
    externalId: row.externalId,
    blocks: asBlocks(row.blocks),
    images: asImages(row.images),
    deliveryProof: row.deliveryProof ?? null,
    silenceReason: row.silenceReason,
    createdAt: row.createdAt,
  };
}

// cm:guard validated on the way OUT and never trusted from the column: `images` is untyped jsonb, so a row written by an older shape, by hand, or by a migration is read back as the parts of it that are still legible rather than crashing the turn that loaded it.
export function asImages(value: unknown): ConversationImage[] {
  if (!Array.isArray(value)) return [];
  const out: ConversationImage[] = [];
  for (const i of value) {
    if (!i || typeof i !== 'object') continue;
    const rec = i as Record<string, unknown>;
    if (typeof rec.name !== 'string' || typeof rec.mime !== 'string') continue;
    if (typeof rec.ref !== 'string' || rec.ref.length === 0) continue;
    out.push({ name: rec.name, mime: rec.mime, ref: rec.ref });
  }
  return out;
}
