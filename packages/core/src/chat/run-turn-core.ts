/**
 * ISS-604 (P2a) — transport-agnostic tool-calling turn loop.
 *
 * The loop that used to live inside `run-turn.ts`'s SSE wrapper, extracted as
 * an async generator so BOTH consumers share one implementation:
 *   - `run-turn.ts` (SSE): forwards each yielded event to the browser.
 *   - `external-chat.ts` (Rocket.Chat / non-streaming): drains the events and
 *     uses the returned final text as the single reply message.
 *
 * It streams one assistant turn; while the model requests tools it executes
 * them, feeds the results back, and re-invokes — up to {@link MAX_TOOL_ITERATIONS}.
 * It performs NO SSE and NO DB writes; the caller owns transport + persistence.
 */

import type {
  ChatMessage,
  ChatProvider,
  ChatStreamEvent,
  ChatStreamUsage,
} from './providers/types.js';
import type { ChatToolset } from './tools/mcp-adapter.js';

// 8 (was 5, ISS-609 follow-up): investigating an external hub takes multi-hop
// chains — issue-search retries → schema introspection → query → act.
export const MAX_TOOL_ITERATIONS = 8;

export interface TurnCoreArgs {
  provider: ChatProvider;
  model: string;
  /** system + history + new user turn. Copied internally, not mutated. */
  messages: ChatMessage[];
  tools?: ChatToolset | undefined;
  signal?: AbortSignal | undefined;
}

export interface TurnCoreResult {
  /** The final assistant text (the round with no tool calls). */
  finalText: string;
  usage: ChatStreamUsage;
  iterations: number;
  toolCalls: Array<{ name: string; arguments: string }>;
  terminal: 'done' | 'error';
  errorMessage: string | null;
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

/**
 * Run the turn, yielding client-facing events (chunk / tool_call / tool_result
 * / usage, then exactly one terminal `done` or `error`) and returning the
 * aggregate result. The generator never throws — provider/tool errors surface
 * as an `error` event + `terminal: 'error'`.
 */
export async function* runTurnEvents(
  args: TurnCoreArgs,
): AsyncGenerator<ChatStreamEvent, TurnCoreResult> {
  const { provider, model, tools, signal } = args;
  const messages: ChatMessage[] = [...args.messages];
  const usage: ChatStreamUsage = {};
  const toolCalls: Array<{ name: string; arguments: string }> = [];
  let finalText = '';
  let errorMessage: string | null = null;
  let terminal: 'done' | 'error' | null = null;
  let iterations = 0;

  try {
    for (;;) {
      iterations++;
      let turnText = '';
      const turnToolCalls: CollectedToolCall[] = [];
      let sawError = false;

      for await (const event of provider.stream({ model, messages, tools: tools?.tools, signal })) {
        if (event.type === 'chunk') {
          turnText += event.text;
          yield event;
        } else if (event.type === 'tool_call') {
          turnToolCalls.push({
            id: event.id,
            name: event.name,
            arguments: typeof event.arguments === 'string' ? event.arguments : '',
          });
          yield event;
        } else if (event.type === 'usage') {
          addUsage(usage, event.usage);
          yield event;
        } else if (event.type === 'error') {
          errorMessage = event.message;
          terminal = 'error';
          sawError = true;
          yield event;
          break;
        }
        // Swallow the provider's per-turn `done`; one terminal event is emitted below.
      }

      if (sawError) break;

      // No tools requested → final assistant turn.
      if (turnToolCalls.length === 0) {
        finalText = turnText;
        terminal = 'done';
        yield { type: 'done' };
        break;
      }

      // Requested tools but none available, or iteration cap hit → finalize.
      if (!tools || iterations >= MAX_TOOL_ITERATIONS) {
        finalText = turnText;
        terminal = 'done';
        yield { type: 'done' };
        break;
      }

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
        toolCalls.push({ name: tc.name, arguments: tc.arguments });
        const result = await tools.execute(tc.name, tc.arguments);
        yield { type: 'tool_result', id: tc.id, result };
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    terminal = 'error';
    yield { type: 'error', message: errorMessage };
  }

  return {
    finalText,
    usage,
    iterations,
    toolCalls,
    terminal: terminal ?? 'done',
    errorMessage,
  };
}
