/**
 * v1 EPIC 1 (ISS-294 / PR-B) — Chat session persistence.
 *
 * Reuses the existing `chat_sessions` table (jsonb `messages` column).
 * Rolling summary fields (`summary`, `summarizedAt`) are left untouched here
 * — a separate housekeeping epic owns summarization.
 */

import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db as defaultDb } from '../db/client.js';
import { chatSessions } from '../db/schema.js';
import type { ChatMessage, ChatRole } from './providers/types.js';

export interface StoredChatMessage {
  role: ChatRole;
  content: string;
  ts: string;
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
    out.push({
      role,
      content,
      ts: typeof rec.ts === 'string' ? rec.ts : new Date().toISOString(),
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

export function appendUserMessage(session: ChatSessionRow, content: string): StoredChatMessage {
  const message: StoredChatMessage = { role: 'user', content, ts: new Date().toISOString() };
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
 */
export function toProviderMessages(session: ChatSessionRow): ChatMessage[] {
  return session.messages.map(({ role, content }) => ({ role, content }));
}
