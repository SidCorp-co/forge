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
import { handleForProject } from '../conversations/participants.js';
import { assertConversationWritable } from '../conversations/scope.js';
import {
  appendMessages,
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
import { effectiveProjectRole, projectRoleAtLeast } from '../lib/authz.js';
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
  /** The handle speaking here — the one carrying this turn's project. An assistant row is BY it. */
  handleUserId: string | null;
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
  /**
   * The authority this turn runs as. A persisted turn APPENDS, so it takes `member` on every
   * project the room is about — not `viewer`, which is permission to look at one.
   */
  readerUserId?: string | null;
  db?: typeof defaultDb;
}

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const badRequest = (message: string, code: string) =>
  new HTTPException(400, { message, cause: { code } });

const conflict = (message: string, code: string) =>
  new HTTPException(409, { message, cause: { code } });

const forbidden = (message: string, code: string) =>
  new HTTPException(403, { message, cause: { code } });

/**
 * The conversation this turn belongs to, with its window read back.
 */
// cm:guard a conversation id from a caller is read-checked against the DERIVED scope, never against a `userId` column: the old check was `row.userId && opts.userId && row.userId !== opts.userId`, which admitted a caller carrying no user id to somebody else's transcript because the middle clause was false (ISS-1001).
export async function openTurn(opts: OpenTurnOptions): Promise<ConversationTurn> {
  const dbi = opts.db ?? defaultDb;

  if (opts.conversationId) {
    const [row] = await dbi
      .select({
        id: conversations.id,
        adapter: conversations.adapter,
        externalId: conversations.externalId,
      })
      .from(conversations)
      .where(eq(conversations.id, opts.conversationId))
      .limit(1);
    if (!row) throw notFound('conversation not found');
    const scope = await assertConversationWritable(row.id, opts.readerUserId ?? null);
    // cm:guard being ALLOWED to read a room is not the same as this turn belonging to it: naming
    // project B and conversation A passes the read check while the tools are built for B.
    // cm:why `openConversation` refuses the same mismatch on the venue path; this is the other door.
    if (!scope.includes(opts.projectId)) {
      throw conflict(
        `conversation ${row.id} is about ${scope.join(', ')} and this turn arrives under project ${opts.projectId}; a turn runs in a room its own project is in`,
        'CONVERSATION_PROJECT_CONFLICT',
      );
    }
    if (row.adapter !== opts.adapter) {
      throw conflict(
        `conversation ${row.id} (${row.adapter} ${row.externalId}) is a ${row.adapter} room and this turn arrives as ${opts.adapter}; a venue's adapter is settled when it is first seen`,
        'CONVERSATION_ADAPTER_CONFLICT',
      );
    }
    return {
      conversationId: row.id,
      adapter: row.adapter,
      handleUserId: await handleForProject(row.id, opts.projectId, dbi),
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

  // cm:guard the venue door takes the SAME authority the conversation-id door takes, to the same `member` bar: unchecked, knowing a room's transport id was a way past the check the other door makes on the very same rows (ISS-1001 invariant 2).
  // cm:guard BEFORE the open so a refused caller leaves no room behind, and again after it, because the first check knows only the project this turn named and the second knows every project the room turns out to be about.
  // cm:why a turn naming no user is refused HERE rather than admitted as the adapter's: a room whose speaker has no Forge account still runs under the authority its adapter resolved (`turn-principal.ts` refuses the DM it cannot resolve and gives a channel the organization's creator), so "no authority" is a caller that forgot one. A turn that belongs to no room — the escalation synthesis — opens no turn at all and reaches none of this.
  if (!opts.readerUserId) {
    throw forbidden(
      `a turn in ${opts.adapter} venue ${opts.externalId} was opened with no authority named; a turn writes to the room it runs in, and nothing here is anonymous`,
      'CONVERSATION_NO_AUTHORITY',
    );
  }
  const access = await effectiveProjectRole(opts.readerUserId, opts.projectId);
  if (!projectRoleAtLeast(access?.role ?? null, 'member')) {
    throw forbidden(
      `a turn in ${opts.adapter} venue ${opts.externalId} arrives under project ${opts.projectId} and you hold no member role on it; a turn writes to the room it runs in, so it takes the role that writing takes`,
      'CONVERSATION_OUT_OF_SCOPE',
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
  await assertConversationWritable(conversation.id, opts.readerUserId);
  return {
    conversationId: conversation.id,
    adapter: conversation.adapter,
    handleUserId: await handleForProject(conversation.id, opts.projectId, dbi),
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

// cm:guard the author defaults to the room's own handle and not to null: a transcript whose assistant
// rows are all by nobody cannot say which handle answered in a room holding two (ISS-1001)
export function appendAssistantMessage(
  turn: ConversationTurn,
  content: string,
  opts: { authorUserId?: string | null; deliveryProof?: unknown } = {},
): void {
  turn.pending.push({
    role: 'assistant',
    content,
    authorUserId: opts.authorUserId ?? turn.handleUserId,
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
    // cm:guard by the same handle an answer would have been by: a silence is this handle declining to
    // speak, and an unattributed one cannot say WHICH handle went quiet in a room holding two.
    authorUserId: turn.handleUserId,
    authorLabel: null,
    images: [],
    deliveryProof: null,
    silenceReason: reason,
  });
}

/** Write everything this turn appended, in order, clear the queue, and hand back the rows. */
// cm:guard ONE write for the turn, and the queue is cleared by the COMMIT never the attempt: row by
// row committed the question and could fail on the answer, unretryably (ISS-1001)
export async function persistMessages(
  turn: ConversationTurn,
  opts: { db?: typeof defaultDb } = {},
): Promise<StoredConversationMessage[]> {
  if (turn.pending.length === 0) return [];
  const written = await appendMessages({
    conversationId: turn.conversationId,
    messages: turn.pending.map((m) => ({
      role: m.role,
      content: m.content,
      authorUserId: m.authorUserId,
      authorLabel: m.authorLabel,
      images: m.images,
      deliveryProof: m.deliveryProof,
      silenceReason: m.silenceReason,
    })),
    ...(opts.db ? { db: opts.db } : {}),
  });
  turn.pending.length = 0;
  turn.history.push(...written);
  return written;
}

/**
 * The window in the provider's wire shape, with this turn's pending user
 * messages on the end so the model sees what was just said.
 */
// cm:guard a message carrying a `silenceReason` is NOT sent to the provider: it is the record that a turn said nothing, and replaying it as an empty assistant turn teaches the model that empty answers are a shape it may produce.
// cm:guard a message with NO text but a resolved image IS sent: a screenshot pasted with no caption is the commonest way a person asks about one, and a length test on the text alone drops the whole message, so the model is asked about a picture it was never shown (ISS-1001).
export function toProviderMessages(
  turn: ConversationTurn,
  resolvedImages?: ReadonlyMap<string, string>,
): ChatMessage[] {
  const resolve = (images: ConversationImage[]) =>
    images.map((i) => resolvedImages?.get(i.ref)).filter((u): u is string => !!u);
  const carried = (m: {
    silenceReason: string | null;
    content: string;
    images: ConversationImage[];
  }) => m.silenceReason === null && (m.content.length > 0 || resolve(m.images).length > 0);
  const all: Array<{
    role: ConversationMessageRole;
    content: string;
    images: ConversationImage[];
  }> = [
    ...turn.history
      .filter(carried)
      .map((m) => ({ role: m.role, content: m.content, images: m.images })),
    ...turn.pending
      .filter(carried)
      .map((m) => ({ role: m.role, content: m.content, images: m.images })),
  ];
  return all.map(({ role, content, images }) => {
    const urls = resolve(images);
    if (urls.length === 0) return { role, content };
    const parts: ChatContentPart[] = [];
    if (content.length > 0) parts.push({ type: 'text', text: content });
    for (const url of urls) parts.push({ type: 'image_url', image_url: { url } });
    return { role, content: parts };
  });
}
