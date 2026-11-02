// The language a chat room speaks, as its people last wrote (ISS-873): what a question the room's
// agent raises unprompted is written in, where no message of the moment says it.

import { and, desc, eq, inArray, like, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { conversationMessages, conversations } from '../db/schema-conversations.js';
import { type ReplyLanguage, replyLanguageOf } from './fallback-replies.js';

/** How many of the room's latest messages from people are read. */
const READ_LAST = 20;

/**
 * The language of the latest messages people wrote in the venue `venue` (its own conversation and
 * every thread under it), or null where nobody wrote one yet.
 */
export async function roomLanguageOf(
  adapter: (typeof conversations.$inferSelect)['adapter'],
  venue: string,
): Promise<ReplyLanguage | null> {
  const venues = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.adapter, adapter),
        or(eq(conversations.externalId, venue), like(conversations.externalId, `${venue} %`)),
      ),
    );
  const said = await db
    .select({ content: conversationMessages.content })
    .from(conversationMessages)
    .where(
      and(
        inArray(conversationMessages.conversationId, venues),
        eq(conversationMessages.role, 'user'),
      ),
    )
    .orderBy(desc(conversationMessages.createdAt))
    .limit(READ_LAST);
  return replyLanguageOf(said.map((m) => m.content).join('\n'));
}
