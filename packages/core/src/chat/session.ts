/**
 * Chat session persistence over the `chat_sessions` table (jsonb `messages`
 * column). Identity model:
 *
 * - `userId` — authenticated owner; null for widget traffic.
 * - The audit key for `chat_logs.userKey` is **not** stored on the session row;
 *   it is passed through `runChatTurn` per turn (see `chat/run-turn.ts`).
 */

import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db as defaultDb } from '../db/client.js';
import { chatSessions } from '../db/schema.js';
import type { ChatContentPart, ChatMessage, ChatRole } from './providers/types.js';

/**
 * An image that arrived with a user turn, stored as a REFERENCE (source URL +
 * metadata), never as bytes.
 */
// cm:guard never widen this to carry base64 — `chat_sessions.messages` holds up to PERSISTED_MESSAGES_CAP (200) turns in one jsonb column, and a single Rocket.Chat screenshot is ~1.1 MB base64, so inlining bytes here trades a bounded row for one that grows past what the column can be read back through
export interface StoredChatImage {
  name: string;
  mime: string;
  /** Absolute URL the bytes can be re-fetched from (credentialed at the edge
   *  that owns the source, e.g. the Rocket.Chat bot token). */
  ref: string;
}

export interface StoredChatMessage {
  role: ChatRole;
  content: string;
  ts: string;
  /** Images attached to this turn; absent on the overwhelming majority. */
  images?: StoredChatImage[];
}

export type ChatSessionSource = 'web' | 'widget' | 'rocketchat' | 'telegram';

export interface ChatSessionRow {
  id: string;
  projectId: string;
  userId: string | null;
  source: ChatSessionSource;
  messages: StoredChatMessage[];
}

export interface LoadOrCreateOptions {
  projectId: string;
  sessionId?: string | undefined;
  userId: string | null;
  source: ChatSessionSource;
  db?: typeof defaultDb;
}

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

function asImages(value: unknown): StoredChatImage[] {
  if (!Array.isArray(value)) return [];
  const out: StoredChatImage[] = [];
  for (const i of value) {
    if (!i || typeof i !== 'object') continue;
    const rec = i as Record<string, unknown>;
    if (typeof rec.name !== 'string' || typeof rec.mime !== 'string') continue;
    if (typeof rec.ref !== 'string' || rec.ref.length === 0) continue;
    out.push({ name: rec.name, mime: rec.mime, ref: rec.ref });
  }
  return out;
}

function asMessages(value: unknown): StoredChatMessage[] {
  if (!Array.isArray(value)) return [];
  const out: StoredChatMessage[] = [];
  for (const m of value) {
    if (!m || typeof m !== 'object') continue;
    const rec = m as Record<string, unknown>;
    const role = rec.role;
    const content = rec.content;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    if (typeof content !== 'string') continue;
    const images = asImages(rec.images);
    out.push({
      role,
      content,
      ts: typeof rec.ts === 'string' ? rec.ts : new Date().toISOString(),
      ...(images.length > 0 ? { images } : {}),
    });
  }
  return out;
}

/**
 * Load an existing session (must belong to the project + user) or create a
 * new one. The returned object is in-memory; mutations to `messages` are
 * persisted by `persistMessages`.
 */
export async function loadOrCreateSession(opts: LoadOrCreateOptions): Promise<ChatSessionRow> {
  const dbi = opts.db ?? defaultDb;

  if (opts.sessionId) {
    const [row] = await dbi
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, opts.sessionId))
      .limit(1);
    if (!row) throw notFound('chat session not found');
    if (row.projectId !== opts.projectId) throw forbidden('session belongs to another project');
    if (row.userId && opts.userId && row.userId !== opts.userId) {
      throw forbidden('not your chat session');
    }
    return {
      id: row.id,
      projectId: row.projectId,
      userId: row.userId,
      source: row.source as ChatSessionSource,
      messages: asMessages(row.messages),
    };
  }

  const [inserted] = await dbi
    .insert(chatSessions)
    .values({
      projectId: opts.projectId,
      userId: opts.userId,
      source: opts.source,
      messages: [] as never,
    })
    .returning();
  if (!inserted) throw new Error('chat_sessions: insert returned no row');

  return {
    id: inserted.id,
    projectId: inserted.projectId,
    userId: inserted.userId,
    source: inserted.source as ChatSessionSource,
    messages: [],
  };
}

export function appendUserMessage(
  session: ChatSessionRow,
  content: string,
  images: readonly StoredChatImage[] = [],
): StoredChatMessage {
  const message: StoredChatMessage = {
    role: 'user',
    content,
    ts: new Date().toISOString(),
    ...(images.length > 0 ? { images: [...images] } : {}),
  };
  session.messages.push(message);
  return message;
}

export function appendAssistantMessage(
  session: ChatSessionRow,
  content: string,
): StoredChatMessage {
  const message: StoredChatMessage = { role: 'assistant', content, ts: new Date().toISOString() };
  session.messages.push(message);
  return message;
}

/**
 * Persist the current `messages` snapshot to `chat_sessions`. Keep this a
 * single round-trip — callers append in memory then flush once at the end of
 * a turn. Updates `updatedAt` so the existing Web UI list re-orders.
 */
export async function persistMessages(
  session: ChatSessionRow,
  opts: { db?: typeof defaultDb } = {},
): Promise<void> {
  const dbi = opts.db ?? defaultDb;
  await dbi
    .update(chatSessions)
    .set({ messages: session.messages as never, updatedAt: new Date() })
    .where(eq(chatSessions.id, session.id));
}

/**
 * Convert stored messages to the provider's wire shape (drops `ts`).
 *
 * `resolvedImages` maps a {@link StoredChatImage.ref} to a
 * `data:<mime>;base64,…` URI; a message whose images are ALL present in the
 * map becomes a multimodal parts array, and every other message stays a plain
 * string. The caller decides which refs to resolve (and pays the fetch), so a
 * long transcript never re-downloads every picture it ever saw.
 */
export function toProviderMessages(
  session: ChatSessionRow,
  resolvedImages?: ReadonlyMap<string, string>,
): ChatMessage[] {
  return session.messages.map(({ role, content, images }) => {
    const urls = images?.map((i) => resolvedImages?.get(i.ref)).filter((u): u is string => !!u);
    if (!urls || urls.length === 0) return { role, content };
    const parts: ChatContentPart[] = [{ type: 'text', text: content }];
    for (const url of urls) parts.push({ type: 'image_url', image_url: { url } });
    return { role, content: parts };
  });
}
