// The conversation ROW: the record a room is, and every read and write over it
// alone.
//
// Split out of `store.ts` at ISS-1028, on the seam the file already had: that
// module opens venues and appends turns, and everything here touches nothing but
// the `conversations` row itself — its columns, the two ways to find one, the
// list a project's rooms make, and the three things a person does to one. The
// split is a file boundary and not an interface change: `store.ts` re-exports
// every name here, the way it already re-exports `canonical-entry.ts`, so no
// caller moved.

import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { projectMembers } from '../db/schema.js';
import {
  type ConversationAdapter,
  type ConversationShape,
  conversationParticipants,
  conversations,
} from '../db/schema-conversations.js';
import type { Executor } from './db-executor.js';

export interface ConversationRow {
  id: string;
  adapter: ConversationAdapter;
  externalId: string;
  shape: ConversationShape;
  title: string | null;
  /** Set = archived: out of the default list, every message still readable by id. */
  archivedAt: Date | null;
}

export const selection = {
  id: conversations.id,
  adapter: conversations.adapter,
  externalId: conversations.externalId,
  shape: conversations.shape,
  title: conversations.title,
  archivedAt: conversations.archivedAt,
};

/** Which side of the archive a list is asking for. */
export interface ConversationListFilter {
  /** `true` lists ONLY archived rooms; absent or `false` lists only live ones. */
  archived?: boolean;
}

// cm:guard a room is on exactly ONE side of this and never on both, which is what makes the toggle
// in the panel a way BACK rather than a second copy: a list that filtered on nothing would put an
// archived room straight back into the default list, and archiving would mean nothing (ISS-1028).
const archiveSide = (archived: boolean | undefined) =>
  archived ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt);

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

export async function listConversationsInProject(
  projectId: string,
  opts: { limit?: number; offset?: number } & ConversationListFilter = {},
  tx: Executor = defaultDb,
): Promise<ConversationRow[]> {
  const bounded = tx
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
    .where(archiveSide(opts.archived))
    .orderBy(desc(conversations.updatedAt));
  if (opts.limit === undefined) return bounded;
  return bounded.limit(opts.limit).offset(opts.offset ?? 0);
}

// cm:guard the SAME `archiveSide` the list uses, and not a second predicate that says the same
// thing: a count that disagreed with its list would page a screen past rooms it never showed.
export async function countConversationsInProject(
  projectId: string,
  opts: ConversationListFilter = {},
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
    )
    .where(archiveSide(opts.archived));
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

// cm:guard archiving STAMPS and never deletes, and unarchiving clears the stamp rather than writing
// a second row: the transcript is what a room is, and a "clean up my list" gesture that destroyed
// one would be the loss this issue was filed about, under a friendlier verb (ISS-1028).
// cm:guard `updatedAt` is left ALONE, unlike the rename above: the list is ordered by it, and
// archiving a room is not something being said in it — bumping it would float a room to the top of
// the archived list for having been put there, and drop it to the bottom of the live list on the
// way back.
export async function setConversationArchived(
  conversationId: string,
  archived: boolean,
  tx: Executor = defaultDb,
): Promise<ConversationRow | null> {
  const [row] = await tx
    .update(conversations)
    .set({ archivedAt: archived ? new Date() : null })
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
