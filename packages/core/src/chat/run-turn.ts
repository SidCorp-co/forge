/**
 * SSE transport for the cookie-auth `/api/chat` (PR-B) route: drives the shared
 * tool-calling loop ({@link runTurnEvents}) and forwards each event to the
 * browser, then persists the final assistant text + a `chat_logs` audit row.
 *
 * ISS-604 — the loop itself lives in `run-turn-core.ts` so the Rocket.Chat
 * (non-streaming) path can reuse it. Only the FINAL assistant text is persisted
 * to the session; intra-turn tool round-trips are ephemeral + audited.
 */

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { db } from '../db/client.js';
import { chatLogs } from '../db/schema.js';
import type { ChatMessage, ChatProvider, ChatStreamEvent } from './providers/types.js';
import { type TurnCoreResult, runTurnEvents } from './run-turn-core.js';
import { type ChatSessionRow, appendAssistantMessage, persistMessages } from './session.js';
import type { ChatToolset } from './tools/mcp-adapter.js';

export interface RunTurnArgs {
  c: Context;
  session: ChatSessionRow;
  /** Resolved provider + model (already chosen by `resolveForProject`). */
  resolved: { provider: ChatProvider; model: string };
  /** The full message array (system + history + new user turn). */
  providerMessages: ChatMessage[];
  /** Optional read-only toolset (ISS-604). Omit for a plain completion. */
  tools?: ChatToolset | undefined;
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
  tools,
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

    const gen = runTurnEvents({
      provider: resolved.provider,
      model: resolved.model,
      messages: providerMessages,
      tools,
      signal: ac.signal,
    });
    let step = await gen.next();
    while (!step.done) {
      await writeEvent(stream, step.value);
      step = await gen.next();
    }
    const result: TurnCoreResult = step.value;

    const durationMs = Date.now() - startedAt;

    if (result.terminal === 'done' && result.finalText.length > 0) {
      appendAssistantMessage(session, result.finalText);
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
        reply: result.finalText.length > 0 ? result.finalText : null,
        model: resolved.model,
        ragContext: null,
        toolCalls: result.toolCalls as never,
        usage: (Object.keys(result.usage).length > 0 ? result.usage : null) as never,
        iterations: result.iterations,
        durationMs,
        error: result.errorMessage,
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
