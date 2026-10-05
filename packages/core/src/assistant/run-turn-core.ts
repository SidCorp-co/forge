/**
 * ISS-604 (P2a) — transport-agnostic tool-calling turn loop: one assistant turn,
 * executing and feeding back tools for as long as the model asks for them, up to
 * {@link MAX_TOOL_ITERATIONS}. `external-chat.ts` drains the events and owns transport and
 * persistence; nothing here writes.
 */

import type {
  ChatMessage,
  ChatProvider,
  ChatStreamEvent,
  ChatStreamUsage,
} from '../integrations/llm/index.js';
import type { CallToolResult } from '../lib/tool-result.js';
import {
  addElision,
  applyContextBudget,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  type ElisionReport,
  emptyElision,
} from './context-budget.js';
import { refusalCodeOf } from './refusal-code.js';
import { type ChatToolset, toolError, toolResultText } from './tools/mcp-adapter.js';

const MAX_TOOL_ITERATIONS = 16;

/** What a tool call record keeps of a result: enough to see what the model was shown, never the full 24k body. */
const RESULT_PREVIEW_CHARS = 500;

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
  /** Estimated-token cap on each provider request; `context-budget.ts` elides to fit. */
  contextBudgetTokens?: number | undefined;
  reasoningEffort?: string | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Read before a tool call is executed; a result returned stands in for the call (recorded with
   * its own `isError`) and the tool never runs. Null lets the call through (ISS-1064).
   */
  preCall?: PreCall | undefined;
}

export interface PreCallContext {
  /** The provider messages so far: system, history, the person's newest turn, this turn's rounds. */
  messages: readonly ChatMessage[];
  /** The tool calls this turn has made so far, refused ones included. */
  toolCalls: readonly ToolCallRecord[];
}

export type PreCall = (
  call: { name: string; arguments: string },
  ctx: PreCallContext,
) => Promise<CallToolResult | null>;

/** One tool call as the turn records it; `name`/`arguments` are what the model emitted, the rest is what happened to it. */
export interface ToolCallRecord {
  name: string;
  arguments: string;
  /** 1-based provider round the call was made on. */
  round: number;
  /** MCP's own flag on the result — a guard rejection, a thrown handler, an external server's error. */
  isError: boolean;
  durationMs: number;
  /** First {@link RESULT_PREVIEW_CHARS} of the text the model read. */
  resultPreview: string;
  /** The user the call ran as, from the toolset that owns it; null for a tool that acts as nobody. */
  ranAs: string | null;
  /** The code a refused call's result named, null where it landed or named none. */
  refusalCode: string | null;
}

export interface TurnCoreResult {
  /** The final assistant text (the round that requested no tools). */
  finalText: string;
  usage: ChatStreamUsage;
  iterations: number;
  toolCalls: ToolCallRecord[];
  /** What the context budget removed over the whole turn. */
  elided: ElisionReport;
  terminal: 'done' | 'error';
  errorMessage: string | null;
}

interface CollectedToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ExecutedCall {
  id: string;
  record: ToolCallRecord;
  /** What the model reads back — the flattened result. */
  text: string;
}

/** A toolset that throws (none do by contract, every implementer returns `toolError`) still yields one result per call, so `Promise.all` over a round cannot drop the other calls' results or turn the turn into a terminal `error`. */
async function safeExecute(toolset: ChatToolset, tc: CollectedToolCall): Promise<CallToolResult> {
  try {
    return await toolset.execute(tc.name, tc.arguments);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

async function executeToolRound(
  toolset: ChatToolset,
  calls: CollectedToolCall[],
  round: number,
  gate?: (
    call: CollectedToolCall,
    completed: readonly ToolCallRecord[],
  ) => Promise<CallToolResult | null>,
): Promise<ExecutedCall[]> {
  const out: ExecutedCall[] = [];
  const completed = (): ToolCallRecord[] => out.flatMap((e) => (e ? [e.record] : []));
  const byName = new Map<string, number[]>();
  for (const [i, tc] of calls.entries()) byName.set(tc.name, [...(byName.get(tc.name) ?? []), i]);
  await Promise.all(
    [...byName.values()].map(async (indices) => {
      for (const i of indices) {
        const call = calls[i] as CollectedToolCall;
        const startedAt = Date.now();
        const held = gate
          ? await gate(call, completed()).catch((err: unknown) =>
              toolError(
                `pre-call gate failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
            )
          : null;
        const result = held ?? (await safeExecute(toolset, call));
        const text = toolResultText(result);
        out[i] = {
          id: call.id,
          text,
          record: {
            name: call.name,
            arguments: call.arguments,
            round,
            isError: result.isError === true,
            durationMs: Date.now() - startedAt,
            resultPreview: text.slice(0, RESULT_PREVIEW_CHARS),
            ranAs: toolset.ranAs(call.name),
            refusalCode: result.isError === true ? refusalCodeOf(text) : null,
          },
        };
      }
    }),
  );
  return out;
}

const USAGE_KEYS = [
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'cachedPromptTokens',
] as const;

function addUsage(into: ChatStreamUsage, from: ChatStreamUsage): void {
  for (const key of USAGE_KEYS) {
    const n = from[key];
    if (n !== undefined) into[key] = (into[key] ?? 0) + n;
  }
}

/**
 * Yields client-facing events (chunk / tool_call / tool_result / usage, then
 * exactly one terminal `done` or `error`; the provider's own per-round `done` is
 * swallowed). Never throws — provider and tool errors become that `error`.
 */
export async function* runTurnEvents(
  args: TurnCoreArgs,
): AsyncGenerator<ChatStreamEvent, TurnCoreResult> {
  const budgetTokens = args.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
  const turn: TurnState = {
    messages: [...args.messages],
    usage: {},
    toolCalls: [],
    elided: emptyElision(),
    iterations: 0,
  };
  const result = (terminal: 'done' | 'error', finalText: string, errorMessage: string | null) => ({
    finalText,
    usage: turn.usage,
    iterations: turn.iterations,
    toolCalls: turn.toolCalls,
    elided: turn.elided,
    terminal,
    errorMessage,
  });

  try {
    for (;;) {
      turn.iterations++;
      const offered = turn.iterations < MAX_TOOL_ITERATIONS ? args.tools : undefined;
      const bounded = applyContextBudget(turn.messages, {
        budgetTokens,
        reservedTokens: Math.ceil(JSON.stringify(offered?.tools ?? []).length / 4),
      });
      turn.messages = bounded.messages;
      addElision(turn.elided, bounded.elided);

      const round = yield* streamRound(args, turn, offered);
      if (round.error !== null) return result('error', '', round.error);
      if (round.calls.length === 0 || !offered) {
        yield { type: 'done' };
        return result('done', round.text, null);
      }
      yield* feedToolRound(args, turn, offered, round);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: 'error', message };
    return result('error', '', message);
  }
}

interface TurnState {
  messages: ChatMessage[];
  usage: ChatStreamUsage;
  toolCalls: ToolCallRecord[];
  elided: ElisionReport;
  iterations: number;
}

interface Round {
  text: string;
  calls: CollectedToolCall[];
  error: string | null;
}

/** One provider request, its events passed through; a tool call is kept only where tools were offered. */
async function* streamRound(
  args: TurnCoreArgs,
  turn: TurnState,
  offered: ChatToolset | undefined,
): AsyncGenerator<ChatStreamEvent, Round> {
  const round: Round = { text: '', calls: [], error: null };
  for await (const event of args.provider.stream({
    model: args.model,
    messages: turn.messages,
    tools: offered?.tools,
    temperature: args.temperature,
    toolChoice:
      args.requireInitialToolUse && turn.iterations === 1 && offered ? 'required' : undefined,
    ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
    signal: args.signal,
  })) {
    if (event.type === 'done' || event.type === 'tool_result') continue;
    if (event.type === 'tool_call') {
      if (!offered) continue;
      round.calls.push({
        id: event.id,
        name: event.name,
        arguments: typeof event.arguments === 'string' ? event.arguments : '',
      });
    }
    if (event.type === 'chunk') round.text += event.text;
    if (event.type === 'usage') addUsage(turn.usage, event.usage);
    yield event;
    if (event.type === 'error') {
      round.error = event.message;
      break;
    }
  }
  return round;
}

/** The round's calls, run and fed back to the model as the next request's tool messages. */
async function* feedToolRound(
  args: TurnCoreArgs,
  turn: TurnState,
  offered: ChatToolset,
  round: Round,
): AsyncGenerator<ChatStreamEvent> {
  turn.messages.push({
    role: 'assistant',
    content: round.text.length > 0 ? round.text : null,
    tool_calls: round.calls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments },
    })),
  });
  const preCall = args.preCall;
  const gate = preCall
    ? (tc: CollectedToolCall, completed: readonly ToolCallRecord[]) =>
        preCall(
          { name: tc.name, arguments: tc.arguments },
          { messages: turn.messages, toolCalls: [...turn.toolCalls, ...completed] },
        )
    : undefined;
  for (const { id, record, text } of await executeToolRound(
    offered,
    round.calls,
    turn.iterations,
    gate,
  )) {
    turn.toolCalls.push(record);
    yield {
      type: 'tool_result',
      id,
      result: text,
      isError: record.isError,
      durationMs: record.durationMs,
    };
    turn.messages.push({ role: 'tool', tool_call_id: id, content: text });
  }
}
