// The conversation itself: opening a venue, appending a turn, reading the log.
//
// Everything here is transport-neutral. What a venue IS — a Rocket.Chat room,
// a thread inside one, a browser tab — the adapter decides; this module only
// knows the pair `(adapter, externalId)` that names it and the handle that
// gives it its scope.

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db as defaultDb } from '../db/client.js';
import { projectMembers } from '../db/schema.js';
import {
  type ConversationAdapter,
  type ConversationMessageRole,
  type ConversationShape,
  conversationMessages,
  conversationParticipants,
  conversations,
} from '../db/schema-conversations.js';
import type { Executor } from './db-executor.js';
import { resolveProjectHandle } from './handles.js';
import { attachOpeningHandle } from './participants.js';
import { derivedScope } from './scope.js';

const conflict = (message: string, code: string) =>
  new HTTPException(409, { message, cause: { code } });

/** Where a conversation happens, in the terms its transport uses for it. */
export interface ConversationVenue {
  adapter: ConversationAdapter;
  externalId: string;
  shape: ConversationShape;
  /** The project whose handle speaks here — the venue's binding, not the room's scope. */
  projectId: string;
  title?: string | null;
}

export interface ConversationRow {
  id: string;
  adapter: ConversationAdapter;
  externalId: string;
  shape: ConversationShape;
  title: string | null;
}

export interface ConversationImage {
  name: string;
  mime: string;
  /** Absolute URL the bytes can be re-fetched from; never the bytes themselves. */
  ref: string;
}

export interface StoredConversationMessage {
  id: string;
  seq: number;
  role: ConversationMessageRole;
  authorUserId: string | null;
  authorLabel: string | null;
  content: string;
  images: ConversationImage[];
  deliveryProof: unknown;
  silenceReason: string | null;
  createdAt: Date;
}

const selection = {
  id: conversations.id,
  adapter: conversations.adapter,
  externalId: conversations.externalId,
  shape: conversations.shape,
  title: conversations.title,
};

export async function getConversation(
  conversationId: string,
  tx: Executor = defaultDb,
): Promise<ConversationRow | null> {
  const [row] = await tx
    .select(selection)
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row ?? null;
}

export async function findConversation(
  adapter: ConversationAdapter,
  externalId: string,
  tx: Executor = defaultDb,
): Promise<ConversationRow | null> {
  const [row] = await tx
    .select(selection)
    .from(conversations)
    .where(and(eq(conversations.adapter, adapter), eq(conversations.externalId, externalId)))
    .limit(1);
  return row ?? null;
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

  return dbi.transaction(async (tx) => {
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
    await attachOpeningHandle(tx, inserted.id, handle.userId);
    return inserted;
  });
}

export interface AppendMessageArgs {
  conversationId: string;
  role: ConversationMessageRole;
  content: string;
  authorUserId?: string | null;
  authorLabel?: string | null;
  images?: readonly ConversationImage[] | undefined;
  deliveryProof?: unknown;
  silenceReason?: string | null;
  db?: typeof defaultDb;
}

/** Append one turn. Every row already in the conversation is left alone. */
// cm:guard the row is locked and the sequence read inside the same transaction: two turns that each read `max(seq)` and each write it plus one lose one of the two, which is exactly what the jsonb blob did on a concurrent write and what the unique index on `(conversation_id, seq)` now refuses outright.
export async function appendMessage(args: AppendMessageArgs): Promise<StoredConversationMessage> {
  const dbi = args.db ?? defaultDb;
  return dbi.transaction(async (tx) => {
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

    const [row] = await tx
      .insert(conversationMessages)
      .values({
        conversationId: args.conversationId,
        seq: (top?.seq ?? -1) + 1,
        role: args.role,
        authorUserId: args.authorUserId ?? null,
        authorLabel: args.authorLabel ?? null,
        content: args.content,
        images: (args.images && args.images.length > 0 ? [...args.images] : null) as never,
        deliveryProof: (args.deliveryProof ?? null) as never,
        silenceReason: args.silenceReason ?? null,
      })
      .returning();
    if (!row) throw new Error('conversation_messages: insert returned no row');

    await tx
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, args.conversationId));

    return toStored(row);
  });
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

/** The conversations one project's handle speaks in, newest first. */
export async function listConversationsInProject(
  projectId: string,
  opts: { limit: number; offset: number },
  tx: Executor = defaultDb,
): Promise<ConversationRow[]> {
  return tx
    .selectDistinct({ ...selection, updatedAt: conversations.updatedAt })
    .from(conversations)
    .innerJoin(
      conversationParticipants,
      and(
        eq(conversationParticipants.conversationId, conversations.id),
        eq(conversationParticipants.kind, 'handle'),
        isNull(conversationParticipants.removedAt),
      ),
    )
    .innerJoin(
      projectMembers,
      and(
        eq(projectMembers.userId, conversationParticipants.userId),
        eq(projectMembers.projectId, projectId),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(opts.limit)
    .offset(opts.offset);
}

export async function countConversationsInProject(
  projectId: string,
  tx: Executor = defaultDb,
): Promise<number> {
  const rows = await tx
    .selectDistinct({ id: conversations.id })
    .from(conversations)
    .innerJoin(
      conversationParticipants,
      and(
        eq(conversationParticipants.conversationId, conversations.id),
        eq(conversationParticipants.kind, 'handle'),
        isNull(conversationParticipants.removedAt),
      ),
    )
    .innerJoin(
      projectMembers,
      and(
        eq(projectMembers.userId, conversationParticipants.userId),
        eq(projectMembers.projectId, projectId),
      ),
    );
  return rows.length;
}

export async function renameConversation(
  conversationId: string,
  title: string | null,
  tx: Executor = defaultDb,
): Promise<ConversationRow | null> {
  const [row] = await tx
    .update(conversations)
    .set({ title, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId))
    .returning(selection);
  return row ?? null;
}

export async function deleteConversation(
  conversationId: string,
  tx: Executor = defaultDb,
): Promise<boolean> {
  const rows = await tx
    .delete(conversations)
    .where(eq(conversations.id, conversationId))
    .returning({ id: conversations.id });
  return rows.length > 0;
}

function toStored(row: typeof conversationMessages.$inferSelect): StoredConversationMessage {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    authorUserId: row.authorUserId,
    authorLabel: row.authorLabel,
    content: row.content,
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
