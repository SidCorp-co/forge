// The assistant's view of a conversation while one turn runs: the window it
// shows the model, and the turns this turn will add.
//
// Replaces the `chat_sessions` blob this module used to load and rewrite whole.
// Appends are held in memory and flushed once at the end of a turn — the same
// single-round-trip contract callers already had — but each one lands as its
// own row, so the turn before it is never rewritten and turn 201 no longer
// deletes turn 1.

import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { assertConversationReadable } from '../conversations/scope.js';
import {
  appendMessage,
  type ConversationImage,
  openConversation,
  readMessages,
  type StoredConversationMessage,
} from '../conversations/store.js';
import { db as defaultDb } from '../db/client.js';
import type {
  ConversationAdapter,
  ConversationMessageRole,
  ConversationShape,
} from '../db/schema-conversations.js';
import { conversations } from '../db/schema-conversations.js';
import type { ChatContentPart, ChatMessage } from './providers/types.js';

export type { ConversationImage };

/** How many stored turns a turn is allowed to read back. Storage is unbounded; the window is not. */
// cm:guard a READ window and no longer a delete: `chat_sessions` truncated the stored blob to this number, so turn 201 removed turn 1 from the record for good. Rows keep everything and the model still sees only what a prompt can hold (ISS-1001).
export const CONVERSATION_READ_WINDOW = 200;

export interface PendingMessage {
  role: ConversationMessageRole;
  content: string;
  authorUserId: string | null;
  authorLabel: string | null;
  images: ConversationImage[];
  deliveryProof: unknown;
  silenceReason: string | null;
}

export interface ConversationTurn {
  conversationId: string;
  adapter: ConversationAdapter;
  /** The window read back at load, oldest first. */
  history: StoredConversationMessage[];
  /** Appended this turn, not yet written. */
  pending: PendingMessage[];
}

export interface OpenTurnOptions {
  /** The project whose handle speaks here. */
  projectId: string;
  adapter: ConversationAdapter;
  /** Continue this conversation; omit with `externalId` to open or resume a venue. */
  conversationId?: string | undefined;
  /** The transport's own id for the venue; omit with `conversationId`. */
  externalId?: string | undefined;
  shape?: ConversationShape;
  title?: string | null;
  /** Who is reading. A conversation is readable only by someone the derived scope admits. */
  readerUserId?: string | null;
  db?: typeof defaultDb;
}

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const badRequest = (message: string, code: string) =>
  new HTTPException(400, { message, cause: { code } });

/**
 * The conversation this turn belongs to, with its window read back.
 */
// cm:guard a conversation id from a caller is read-checked against the DERIVED scope, never against a `userId` column: the old check was `row.userId && opts.userId && row.userId !== opts.userId`, which admitted a caller carrying no user id to somebody else's transcript because the middle clause was false (ISS-1001).
export async function openTurn(opts: OpenTurnOptions): Promise<ConversationTurn> {
  const dbi = opts.db ?? defaultDb;

  if (opts.conversationId) {
    const [row] = await dbi
      .select({ id: conversations.id, adapter: conversations.adapter })
      .from(conversations)
      .where(eq(conversations.id, opts.conversationId))
      .limit(1);
    if (!row) throw notFound('conversation not found');
    await assertConversationReadable(row.id, opts.readerUserId ?? null);
    return {
      conversationId: row.id,
      adapter: row.adapter,
      history: await readMessages(row.id, CONVERSATION_READ_WINDOW, dbi),
      pending: [],
    };
  }

  if (!opts.externalId) {
    throw badRequest(
      'a turn needs the conversation it continues or the venue it happens in; with neither there is no room to speak in',
      'CONVERSATION_UNADDRESSED',
    );
  }

  const conversation = await openConversation(
    {
      adapter: opts.adapter,
      externalId: opts.externalId,
      shape: opts.shape ?? 'direct',
      projectId: opts.projectId,
      title: opts.title ?? null,
    },
    { db: dbi },
  );
  return {
    conversationId: conversation.id,
    adapter: conversation.adapter,
    history: await readMessages(conversation.id, CONVERSATION_READ_WINDOW, dbi),
    pending: [],
  };
}

export function appendUserMessage(
  turn: ConversationTurn,
  content: string,
  opts: {
    images?: readonly ConversationImage[];
    authorUserId?: string | null;
    authorLabel?: string | null;
  } = {},
): void {
  turn.pending.push({
    role: 'user',
    content,
    authorUserId: opts.authorUserId ?? null,
    authorLabel: opts.authorLabel ?? null,
    images: opts.images ? [...opts.images] : [],
    deliveryProof: null,
    silenceReason: null,
  });
}

export function appendAssistantMessage(
  turn: ConversationTurn,
  content: string,
  opts: { authorUserId?: string | null; deliveryProof?: unknown } = {},
): void {
  turn.pending.push({
    role: 'assistant',
    content,
    authorUserId: opts.authorUserId ?? null,
    authorLabel: null,
    images: [],
    deliveryProof: opts.deliveryProof ?? null,
    silenceReason: null,
  });
}

/** A turn that produced no text, recorded as the reason rather than as nothing. */
// cm:guard a silence with no row is indistinguishable from a turn that never ran, and a person looking at the room cannot tell "the model chose not to answer" from "nothing reached us" — which is the distinction ISS-1001 invariant 7 exists to make readable.
export function appendSilence(turn: ConversationTurn, reason: string): void {
  turn.pending.push({
    role: 'assistant',
    content: '',
    authorUserId: null,
    authorLabel: null,
    images: [],
    deliveryProof: null,
    silenceReason: reason,
  });
}

/** Write everything this turn appended, in order, and clear the queue. */
export async function persistMessages(
  turn: ConversationTurn,
  opts: { db?: typeof defaultDb } = {},
): Promise<void> {
  const dbi = opts.db ?? defaultDb;
  while (turn.pending.length > 0) {
    const next = turn.pending.shift() as PendingMessage;
    const stored = await appendMessage({
      conversationId: turn.conversationId,
      role: next.role,
      content: next.content,
      authorUserId: next.authorUserId,
      authorLabel: next.authorLabel,
      images: next.images,
      deliveryProof: next.deliveryProof,
      silenceReason: next.silenceReason,
      db: dbi,
    });
    turn.history.push(stored);
  }
}

/**
 * The window in the provider's wire shape, with this turn's pending user
 * messages on the end so the model sees what was just said.
 */
// cm:guard a message carrying a `silenceReason` is NOT sent to the provider: it is the record that a turn said nothing, and replaying it as an empty assistant turn teaches the model that empty answers are a shape it may produce.
export function toProviderMessages(
  turn: ConversationTurn,
  resolvedImages?: ReadonlyMap<string, string>,
): ChatMessage[] {
  const all: Array<{
    role: ConversationMessageRole;
    content: string;
    images: ConversationImage[];
  }> = [
    ...turn.history
      .filter((m) => m.silenceReason === null && m.content.length > 0)
      .map((m) => ({ role: m.role, content: m.content, images: m.images })),
    ...turn.pending
      .filter((m) => m.silenceReason === null && m.content.length > 0)
      .map((m) => ({ role: m.role, content: m.content, images: m.images })),
  ];
  return all.map(({ role, content, images }) => {
    const urls = images.map((i) => resolvedImages?.get(i.ref)).filter((u): u is string => !!u);
    if (urls.length === 0) return { role, content };
    const parts: ChatContentPart[] = [{ type: 'text', text: content }];
    for (const url of urls) parts.push({ type: 'image_url', image_url: { url } });
    return { role, content: parts };
  });
}
