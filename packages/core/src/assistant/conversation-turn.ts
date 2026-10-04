import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import {
  appendMessages,
  assertConversationReadable,
  type ConversationImage,
  handleForProject,
  readMessages,
  refuseConversation,
  type StoredConversationMessage,
} from '../conversations/index.js';
import { db } from '../db/client.js';
import type { ConversationAdapter, ConversationMessageRole } from '../db/schema-conversations.js';
import { conversations } from '../db/schema-conversations.js';
import type { ChatContentPart, ChatMessage } from '../integrations/llm/index.js';

/** How many stored turns a turn is allowed to read back. Storage is unbounded; the window is not. */
const CONVERSATION_READ_WINDOW = 200;

interface PendingMessage {
  role: ConversationMessageRole;
  content: string;
  authorUserId: string | null;
  authorLabel: string | null;
  images: ConversationImage[];
  silenceReason: string | null;
}

export interface ConversationTurn {
  conversationId: string;
  /** The handle speaking here — the one carrying this turn's project. An assistant row is BY it. */
  handleUserId: string | null;
  /** The window read back at load, oldest first. */
  history: StoredConversationMessage[];
  /** Appended this turn, not yet written. */
  pending: PendingMessage[];
}

/**
 * The conversation this turn continues, with its window read back. The turn appends only the
 * handle's reply, so `readerUserId` needs to see the room; each tool takes the role its write takes
 * (ISS-17).
 */
export async function openTurn(opts: {
  projectId: string;
  adapter: ConversationAdapter;
  conversationId: string;
  readerUserId: string | null;
}): Promise<ConversationTurn> {
  const [row] = await db
    .select({
      id: conversations.id,
      adapter: conversations.adapter,
      externalId: conversations.externalId,
    })
    .from(conversations)
    .where(eq(conversations.id, opts.conversationId))
    .limit(1);
  if (!row) {
    throw new HTTPException(404, {
      message: 'conversation not found',
      cause: { code: 'NOT_FOUND' },
    });
  }
  const scope = await assertConversationReadable(row.id, opts.readerUserId);
  if (!scope.includes(opts.projectId)) {
    throw refuseConversation(
      'CONVERSATION_PROJECT_CONFLICT',
      `conversation ${row.id} is about ${scope.join(', ')} and this turn arrives under project ${opts.projectId}; a turn runs in a room its own project is in`,
    );
  }
  if (row.adapter !== opts.adapter) {
    throw refuseConversation(
      'CONVERSATION_ADAPTER_CONFLICT',
      `conversation ${row.id} (${row.adapter} ${row.externalId}) is a ${row.adapter} room and this turn arrives as ${opts.adapter}; a venue's adapter is settled when it is first seen`,
    );
  }
  return {
    conversationId: row.id,
    handleUserId: await handleForProject(row.id, opts.projectId),
    history: await readMessages(row.id, CONVERSATION_READ_WINDOW),
    pending: [],
  };
}

export function appendUserMessage(
  turn: ConversationTurn,
  content: string,
  author: {
    images: readonly ConversationImage[];
    authorUserId: string | null;
    authorLabel: string | null;
  },
): void {
  turn.pending.push({
    role: 'user',
    content,
    ...author,
    images: [...author.images],
    silenceReason: null,
  });
}

/** A turn that produced no text, recorded as the reason rather than as nothing. */
export function appendSilence(turn: ConversationTurn, reason: string): void {
  turn.pending.push({
    role: 'assistant',
    content: '',
    authorUserId: turn.handleUserId,
    authorLabel: null,
    images: [],
    silenceReason: reason,
  });
}

/** Write everything this turn appended, in order, and clear the queue. */
export async function persistMessages(turn: ConversationTurn): Promise<void> {
  if (turn.pending.length === 0) return;
  const written = await appendMessages({
    conversationId: turn.conversationId,
    messages: turn.pending.map((m) => ({ ...m, blocks: null, deliveryProof: null })),
  });
  turn.pending.length = 0;
  turn.history.push(...written);
}

/**
 * The window in the provider's wire shape, with this turn's pending user
 * messages on the end so the model sees what was just said.
 */
export function toProviderMessages(
  turn: ConversationTurn,
  resolvedImages?: ReadonlyMap<string, string>,
): ChatMessage[] {
  const resolve = (images: ConversationImage[]) =>
    images.map((i) => resolvedImages?.get(i.ref)).filter((u): u is string => !!u);
  return [...turn.history, ...turn.pending]
    .filter(
      (m) => m.silenceReason === null && (m.content.length > 0 || resolve(m.images).length > 0),
    )
    .map(({ role, content, images }) => {
      const urls = resolve(images);
      if (urls.length === 0) return { role, content };
      const parts: ChatContentPart[] = [];
      if (content.length > 0) parts.push({ type: 'text', text: content });
      for (const url of urls) parts.push({ type: 'image_url', image_url: { url } });
      return { role, content: parts };
    });
}
