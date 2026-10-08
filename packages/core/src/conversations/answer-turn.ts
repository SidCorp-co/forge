// One assistant turn, read from any one of its messages: what the person asked, then everything the
// assistant posted before the next person spoke — the blocks a turn posts above its reply are their
// own messages (`assistant/conversation-adapter.ts:postServiceAnswer`), and a turn that ran past its
// first ceiling posts a partial and then the rest. A share of any of them is a share of the whole.

import { and, asc, desc, eq, gt, lt, lte, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type ConversationMessageRole, conversationMessages } from '../db/schema-conversations.js';

/** How many messages a turn is read with at most, on either side of its question. */
const TURN_READ_MAX = 200;

export interface AnswerTurn {
  conversationId: string;
  /** The named message's own role: a person's message is no answer. */
  role: ConversationMessageRole;
  /** The person's messages just before the turn, oldest first, joined by a line; null where none came. */
  question: string | null;
  /** The assistant's messages of the turn, oldest first. */
  messages: {
    id: string;
    content: string;
    blocks: unknown;
    deliveryProof: unknown;
    silenceReason: string | null;
  }[];
}

/** The turn `messageId` belongs to, or null where no message has the id. */
export async function readAnswerTurn(messageId: string): Promise<AnswerTurn | null> {
  const [named] = await db
    .select({
      conversationId: conversationMessages.conversationId,
      seq: conversationMessages.seq,
      role: conversationMessages.role,
    })
    .from(conversationMessages)
    .where(eq(conversationMessages.id, messageId))
    .limit(1);
  if (!named) return null;
  const inRoom = eq(conversationMessages.conversationId, named.conversationId);
  const isPerson = eq(conversationMessages.role, 'user');
  if (named.role === 'user') {
    return { conversationId: named.conversationId, role: named.role, question: null, messages: [] };
  }
  const [before] = await db
    .select({ seq: conversationMessages.seq })
    .from(conversationMessages)
    .where(and(inRoom, isPerson, lt(conversationMessages.seq, named.seq)))
    .orderBy(desc(conversationMessages.seq))
    .limit(1);
  const [after] = await db
    .select({ seq: conversationMessages.seq })
    .from(conversationMessages)
    .where(and(inRoom, isPerson, gt(conversationMessages.seq, named.seq)))
    .orderBy(asc(conversationMessages.seq))
    .limit(1);
  const answer = await db
    .select({
      id: conversationMessages.id,
      content: conversationMessages.content,
      blocks: conversationMessages.blocks,
      deliveryProof: conversationMessages.deliveryProof,
      silenceReason: conversationMessages.silenceReason,
    })
    .from(conversationMessages)
    .where(
      and(
        inRoom,
        eq(conversationMessages.role, 'assistant'),
        gt(conversationMessages.seq, before?.seq ?? -1),
        ...(after ? [lt(conversationMessages.seq, after.seq)] : []),
      ),
    )
    .orderBy(asc(conversationMessages.seq))
    .limit(TURN_READ_MAX);
  return {
    conversationId: named.conversationId,
    role: named.role,
    question: before ? await questionEndingAt(named.conversationId, before.seq) : null,
    messages: answer,
  };
}

/** The run of person messages ending at `seq`, oldest first, joined: what the turn was asked. */
async function questionEndingAt(conversationId: string, seq: number): Promise<string | null> {
  const [answeredBefore] = await db
    .select({ seq: conversationMessages.seq })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        ne(conversationMessages.role, 'user'),
        lt(conversationMessages.seq, seq),
      ),
    )
    .orderBy(desc(conversationMessages.seq))
    .limit(1);
  const asked = await db
    .select({ content: conversationMessages.content })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        eq(conversationMessages.role, 'user'),
        gt(conversationMessages.seq, answeredBefore?.seq ?? -1),
        lte(conversationMessages.seq, seq),
      ),
    )
    .orderBy(asc(conversationMessages.seq))
    .limit(TURN_READ_MAX);
  const text = asked
    .map((m) => m.content.trim())
    .filter(Boolean)
    .join('\n');
  return text || null;
}
