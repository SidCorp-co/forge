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
import { logger } from '../lib/logger.js';

/**
 * The message a correction's thread is read up to: a conversation message by its id (a person's
 * reply, `consumers.ts:correctionFromReply`), or the reply a room agent audited, by the chat message
 * id it was posted under (`support/reply-audit/audit.ts:auditReply`).
 */
export type ThreadMessage = { id: string } | { externalId: string };

const AUDIT_REF = /^audit:([^:]+):(.+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The source ref a room agent's failed audit of its own reply is kept under: one per room and reply. */
export const auditCorrectionRef = (roomId: string, chatMessageId: string): string =>
  `audit:${roomId}:${chatMessageId}`;

/**
 * The message a chat or room correction's source ref names, or null where it is neither shape. An
 * audit's ref is no message uuid: read as one, Postgres refused the cast and the steward's lessons
 * pass failed on forge-dev at its first step from 2026-11-17 12:10Z on, every pass (ISS-1251 round 6).
 */
export function threadMessageOf(sourceRef: string): ThreadMessage | null {
  const audit = AUDIT_REF.exec(sourceRef);
  if (audit?.[2]) return { externalId: audit[2] };
  return UUID.test(sourceRef) ? { id: sourceRef } : null;
}

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

/** The reply `message` names and the posts before it in its conversation, oldest first; empty where it is gone. */
export async function threadBefore(
  conversationId: string,
  message: ThreadMessage,
  posts = THREAD_POSTS,
): Promise<ThreadPost[]> {
  const [reply] = await db
    .select({ seq: conversationMessages.seq })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        'id' in message
          ? eq(conversationMessages.id, message.id)
          : eq(conversationMessages.externalId, message.externalId),
      ),
    )
    .limit(1);
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

/**
 * The thread a chat or room correction was said in, read up to the message its source ref names. No
 * writer keeps one under another ref; one that does is said and read alone, never cast into a query
 * that fails the steward's whole pass (ISS-1251 round 6).
 */
export async function correctionThread(
  correctionId: string,
  conversationId: string,
  sourceRef: string,
  posts = THREAD_POSTS,
): Promise<ThreadPost[]> {
  const message = threadMessageOf(sourceRef);
  if (message) return threadBefore(conversationId, message, posts);
  logger.warn(
    { correction: correctionId, sourceRef },
    'lessons: a correction names no message its thread can be read up to; it is read alone',
  );
  return [];
}
