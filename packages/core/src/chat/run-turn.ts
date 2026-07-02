/**
 * SSE turn runner for the cookie-auth `/api/chat` (PR-B) route. Loads a
 * project + provider + session and streams the assistant reply.
 *
 * ISS-604 — when a toolset is supplied the turn becomes a tool-calling loop:
 * stream the assistant, and while it requests tools, execute them and
 * re-invoke the provider with the results, up to {@link MAX_TOOL_ITERATIONS}.
 * Only the FINAL assistant text (the round with no tool calls) is persisted to
 * the session; intra-turn tool round-trips are ephemeral + audited to
 * `chat_logs`.
 */

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { db } from '../db/client.js';
import { chatLogs } from '../db/schema.js';
import type {
  ChatMessage,
  ChatProvider,
  ChatStreamEvent,
  ChatStreamUsage,
} from './providers/types.js';
import { type ChatSessionRow, appendAssistantMessage, persistMessages } from './session.js';
import type { ChatToolset } from './tools/mcp-adapter.js';

const MAX_TOOL_ITERATIONS = 5;

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

interface CollectedToolCall {
  id: string;
  name: string;
  arguments: string;
}

function addUsage(into: ChatStreamUsage, from: ChatStreamUsage): void {
  if (from.promptTokens !== undefined)
    into.promptTokens = (into.promptTokens ?? 0) + from.promptTokens;
  if (from.completionTokens !== undefined)
    into.completionTokens = (into.completionTokens ?? 0) + from.completionTokens;
  if (from.totalTokens !== undefined) into.totalTokens = (into.totalTokens ?? 0) + from.totalTokens;
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
    const messages: ChatMessage[] = [...providerMessages];
    const usage: ChatStreamUsage = {};
    const auditToolCalls: Array<{ name: string; arguments: string }> = [];
    let finalText = '';
    let errorMessage: string | null = null;
    let terminal: 'done' | 'error' | null = null;
    let iterations = 0;

    try {
      // Tool-calling loop. Each pass streams one assistant turn; if it requests
      // tools we execute them, append the results, and loop again.
      for (;;) {
        iterations++;
        let turnText = '';
        const turnToolCalls: CollectedToolCall[] = [];
        let sawError = false;

        for await (const event of resolved.provider.stream({
          model: resolved.model,
          messages,
          tools: tools?.tools,
          signal: ac.signal,
        })) {
          if (event.type === 'chunk') {
            turnText += event.text;
            await writeEvent(stream, event);
          } else if (event.type === 'tool_call') {
            turnToolCalls.push({
              id: event.id,
              name: event.name,
              arguments: typeof event.arguments === 'string' ? event.arguments : '',
            });
            await writeEvent(stream, event);
          } else if (event.type === 'usage') {
            addUsage(usage, event.usage);
            await writeEvent(stream, event);
          } else if (event.type === 'error') {
            errorMessage = event.message;
            terminal = 'error';
            sawError = true;
            await writeEvent(stream, event);
            break;
          }
          // Swallow the provider's per-turn `done` — we emit one terminal
          // `done` for the whole loop below.
        }

        if (sawError) break;

        // No tools requested → this is the final assistant turn.
        if (turnToolCalls.length === 0) {
          finalText = turnText;
          terminal = 'done';
          await writeEvent(stream, { type: 'done' });
          break;
        }

        // Requested tools but we can't run them (none available) or we've hit
        // the iteration cap → finalize with whatever text we have.
        if (!tools || iterations >= MAX_TOOL_ITERATIONS) {
          finalText = turnText;
          terminal = 'done';
          await writeEvent(stream, { type: 'done' });
          break;
        }

        // Record the assistant's tool-call turn, execute each call, and feed
        // the results back for the next round.
        messages.push({
          role: 'assistant',
          content: turnText.length > 0 ? turnText : null,
          tool_calls: turnToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });

        for (const tc of turnToolCalls) {
          auditToolCalls.push({ name: tc.name, arguments: tc.arguments });
          const result = await tools.execute(tc.name, tc.arguments);
          await writeEvent(stream, { type: 'tool_result', id: tc.id, result });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      terminal = 'error';
      await writeEvent(stream, { type: 'error', message: errorMessage });
    }

    const durationMs = Date.now() - startedAt;

    if (terminal === 'done' && finalText.length > 0) {
      appendAssistantMessage(session, finalText);
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
        reply: finalText.length > 0 ? finalText : null,
        model: resolved.model,
        ragContext: null,
        toolCalls: auditToolCalls as never,
        usage: (Object.keys(usage).length > 0 ? usage : null) as never,
        iterations,
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
