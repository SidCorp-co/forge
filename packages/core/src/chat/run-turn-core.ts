/**
 * ISS-604 (P2a) — transport-agnostic tool-calling turn loop: one assistant turn,
 * executing and feeding back tools for as long as the model asks for them, up to
 * {@link MAX_TOOL_ITERATIONS}. Shared so neither consumer owns a private copy —
 * `run-turn.ts` (SSE) forwards each event to the browser, `external-chat.ts`
 * (Rocket.Chat) drains them and sends the final text as one message. NO SSE and
 * NO DB writes here; the caller owns transport and persistence.
 */

import type {
  ChatMessage,
  ChatProvider,
  ChatStreamEvent,
  ChatStreamUsage,
} from './providers/types.js';
import type { ChatToolset } from './tools/mcp-adapter.js';

// cm:guard 8 (was 5, ISS-609 follow-up) because investigating an external hub takes multi-hop chains — issue-search retries, schema introspection, query, act — and it counts PROVIDER rounds, not tool rounds: the final round MUST be invoked with NO tools (so 7 of the 8 carry them) — a model offered them on the round the loop will not iterate past answers with tool calls and no prose, and finalizing on THAT round returns '' as a `done` turn: seven round-trips of tool work billed, a chat_logs row that reads like a healthy answer. What the cap buys is that the eighth round is SPENT on an answer instead of being discarded; it does NOT make a last-round tool call visible — that round carries no schemas and a call invented there is dropped, which is the rule of the guard on the tool_call branch below, not this one's to restate
export const MAX_TOOL_ITERATIONS = 8;

export interface TurnCoreArgs {
  provider: ChatProvider;
  model: string;
  /** system + history + new user turn. Copied internally, not mutated. */
  messages: ChatMessage[];
  tools?: ChatToolset | undefined;
  temperature?: number | undefined;
  /** `tool_choice:'required'` on the FIRST round only, so a lazy model cannot
   *  answer without investigating and the loop can still terminate. */
  requireInitialToolUse?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface TurnCoreResult {
  /** The final assistant text (the round that requested no tools). */
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
 * Yields client-facing events (chunk / tool_call / tool_result / usage, then
 * exactly one terminal `done` or `error`; the provider's own per-round `done` is
 * swallowed). Never throws — provider and tool errors become that `error`.
 */
export async function* runTurnEvents(
  args: TurnCoreArgs,
): AsyncGenerator<ChatStreamEvent, TurnCoreResult> {
  const { provider, model, tools, temperature, signal } = args;
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
      const offered = iterations < MAX_TOOL_ITERATIONS ? tools : undefined;
      let turnText = '';
      const turnToolCalls: CollectedToolCall[] = [];
      let sawError = false;

      for await (const event of provider.stream({
        model,
        messages,
        tools: offered?.tools,
        temperature,
        toolChoice:
          args.requireInitialToolUse && iterations === 1 && offered ? 'required' : undefined,
        signal,
      })) {
        if (event.type === 'chunk') {
          turnText += event.text;
          yield event;
        } else if (event.type === 'tool_call') {
          // cm:guard a tool call arriving on the terminal round is dropped, not forwarded and not recorded — that round is invoked with NO tool schemas, so nothing will execute it and no `tool_result` can ever follow: yielding it hands the SSE client exactly the dangling pair this cap exists to prevent, and putting it in `toolCalls` tells external-chat.ts an `escalate` ran when nothing ran. The round's prose is still the answer; a round that emitted only this is an empty answer, and that is the model's fact to own rather than the loop's to hide
          if (!offered) continue;
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
      }

      if (sawError) break;

      if (turnToolCalls.length === 0 || !offered) {
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
        const result = await offered.execute(tc.name, tc.arguments);
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
