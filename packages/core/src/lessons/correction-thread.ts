/**
 * The thread around a correction said in a chat or a room (REQ-50 BC-1, ISS-1251): the posts the
 * person's reply answers, read before anyone writes down what the reply corrects. A reply read alone
 * is read against the wrong subject: "use the project's language" said under a post about a
 * product's error messages is about those messages, not about the assistant's own words (forge L-103,
 * 2026-11-16, drawn from two room corrections whose thread nobody read).
 */

import { and, desc, eq, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { conversationMessages } from '../db/schema-conversations.js';

/** The posts read before a reply: the reply itself and the ones just before it. */
export const THREAD_POSTS = 6;
/** How much of each post is read. */
const POST_CHARS = 600;
export interface ThreadPost {
  /** `assistant` for the agent's post, `person` for anyone else's. */
  who: 'assistant' | 'person';
  label: string | null;
  text: string;
}

/** The reply `messageId` and the posts before it in its conversation, oldest first; empty where it is gone. */
export async function threadBefore(
  conversationId: string,
  messageId: string,
  posts = THREAD_POSTS,
): Promise<ThreadPost[]> {
  const [reply] = await db
    .select({ seq: conversationMessages.seq })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        eq(conversationMessages.id, messageId),
      ),
    );
  if (!reply) return [];
  const rows = await db
    .select({
      role: conversationMessages.role,
      label: conversationMessages.authorLabel,
      content: conversationMessages.content,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        lte(conversationMessages.seq, reply.seq),
      ),
    )
    .orderBy(desc(conversationMessages.seq))
    .limit(posts);
  return rows.reverse().map((r) => ({
    who: r.role === 'assistant' ? 'assistant' : 'person',
    label: r.label,
    text: r.content,
  }));
}

/** The thread as a model reads it: one post per line, oldest first, each cut to `chars`. */
export function threadLines(
  thread: readonly ThreadPost[],
  chars = POST_CHARS,
  indent = '',
): string {
  return thread
    .map((p) => {
      const who = p.who === 'assistant' ? 'Assistant' : `Person${p.label ? ` (${p.label})` : ''}`;
      return `${indent}${who}: ${p.text.slice(0, chars).replace(/\s+/g, ' ').trim()}`;
    })
    .join('\n');
}
