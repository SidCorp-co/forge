/**
 * SSE turn runner for the cookie-auth `/api/chat` (PR-B) route. Loads a
 * project + provider + session and streams the assistant reply.
 */

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { db } from '../db/client.js';
import { chatLogs } from '../db/schema.js';
import type { ChatProvider } from './providers/types.js';
import type { ChatStreamEvent, ChatStreamUsage } from './providers/types.js';
import {
  appendAssistantMessage,
  type ChatSessionRow,
  persistMessages,
} from './session.js';

export interface RunTurnArgs {
  c: Context;
  session: ChatSessionRow;
  /** Resolved provider + model (already chosen by `resolveForProject`). */
  resolved: { provider: ChatProvider; model: string };
  /** The full message array (system + history + new user turn). */
  providerMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** Project slug for `chat_logs.project_slug`. */
  projectSlug: string;
  /** The new user message text — written verbatim into `chat_logs.query`. */
  userMessage: string;
  /** Caller key for `chat_logs.user_key` (userId for web, null for widget). */
  userKey: string | null;
}

export function runChatTurn({
  c,
  session,
  resolved,
  providerMessages,
  projectSlug,
  userMessage,
  userKey,
}: RunTurnArgs) {
  return streamSSE(c, async (stream) => {
    // Disable buffering on Traefik / nginx so events flush immediately.
    c.header('X-Accel-Buffering', 'no');
    // Echo back the resolved sessionId so the client can stash it for the
    // next turn without parsing a separate REST response.
    await stream.writeSSE({
      event: 'session',
      data: JSON.stringify({ sessionId: session.id }),
    });

    const ac = new AbortController();
    stream.onAbort(() => ac.abort());

    const startedAt = Date.now();
    let assistantText = '';
    let usage: ChatStreamUsage | null = null;
    let errorMessage: string | null = null;
    let terminal: 'done' | 'error' | null = null;

    try {
      for await (const event of resolved.provider.stream({
        model: resolved.model,
        messages: providerMessages,
        signal: ac.signal,
      })) {
        if (event.type === 'chunk') {
          assistantText += event.text;
        } else if (event.type === 'usage') {
          usage = event.usage;
        } else if (event.type === 'error') {
          errorMessage = event.message;
          terminal = 'error';
        } else if (event.type === 'done') {
          terminal = 'done';
        }
        await writeEvent(stream, event);
        if (event.type === 'done' || event.type === 'error') break;
      }
      if (terminal === null) {
        terminal = 'done';
        await writeEvent(stream, { type: 'done' });
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      terminal = 'error';
      await writeEvent(stream, { type: 'error', message: errorMessage });
    }

    const durationMs = Date.now() - startedAt;

    if (terminal === 'done' && assistantText.length > 0) {
      appendAssistantMessage(session, assistantText);
      await persistMessages(session);
    } else {
      // Persist the user message even on error so the UI can surface the
      // partial turn and the user's prior context isn't lost.
      await persistMessages(session);
    }

    try {
      await db.insert(chatLogs).values({
        sessionId: session.id,
        projectSlug,
        userKey,
        query: userMessage,
        reply: assistantText.length > 0 ? assistantText : null,
        model: resolved.model,
        ragContext: null,
        toolCalls: [] as never,
        usage: (usage as never) ?? null,
        iterations: 1,
        durationMs,
        error: errorMessage,
        queryIntent: null,
        source: session.source,
      });
    } catch (err) {
      // chat_logs is best-effort audit — don't fail the request when the
      // INSERT errors (e.g. db pool exhausted). The SSE stream has already
      // delivered to the client; logging the failure is enough.
      console.error('chat_logs insert failed', err);
    }
  });
}

async function writeEvent(
  stream: { writeSSE: (msg: { event: string; data: string }) => Promise<void> },
  event: ChatStreamEvent,
): Promise<void> {
  const { type, ...rest } = event;
  await stream.writeSSE({ event: type, data: JSON.stringify(rest) });
}
