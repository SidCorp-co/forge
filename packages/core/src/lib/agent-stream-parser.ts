/**
 * Claude stream-json → canonical `agent_sessions.messages`.
 *
 * The `forge-runner` CLI holds only a device token and cannot call the
 * user-JWT-gated `PATCH /api/agent-sessions/:id`, but it streams every raw
 * stream-json line to core as a `stdout` job_event — so core derives the
 * transcript itself (ISS-283).
 *
 * Id generation is a per-derive factory (`createIdFactory`) rather than a
 * module-level counter: ids only need to be unique within one session's message
 * array, and a shared mutable would make a multi-session server
 * non-deterministic. `buildSessionFromEvents` threads one factory per pass,
 * which is what makes a re-derive idempotent.
 */

// Optional fields carry explicit `| undefined` because core compiles with
// `exactOptionalPropertyTypes: true` (the desktop source does not) and the
// parser assigns `undefined` to several of these by design.
export interface ToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown> | undefined;
  output?: string | undefined;
  /** `tool_result.is_error`. Measured on forge-beta 2026-08-23: 1,051 of 33,671
   *  tool results over 3 days carry `is_error: true`, and every one of them
   *  rendered as an ordinary row until this field was kept. */
  isError?: boolean | undefined;
  /** tool_use event → tool_result event, in ms. Not in the stream: derived by
   *  `buildSessionFromEvents` from the two job_events' own timestamps. */
  durationMs?: number | undefined;
}

export interface AgentTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string | undefined;
}

export interface ContentBlock {
  type: 'text' | 'tool' | 'todos';
  text?: string | undefined;
  toolCall?: ToolCall | undefined;
  todos?: AgentTodo[] | undefined;
}

export interface AgentMessage {
  id: string;
  type: 'assistant' | 'tool_use' | 'tool_result' | 'system' | 'user';
  timestamp: number;
  content?: string | undefined;
  toolName?: string | undefined;
  toolInput?: Record<string, unknown> | undefined;
  toolOutput?: string | undefined;
  toolCalls?: ToolCall[] | undefined;
  blocks?: ContentBlock[] | undefined;
  subtype?: string | undefined;
  model?: string | undefined;
  /** `tool_result.is_error`, on the tool_result message itself; mergeMessages
   *  copies it onto the matching toolCall. */
  isError?: boolean | undefined;
  /** Set by `buildSessionFromEvents` on a tool_result message before merging;
   *  mergeMessages moves it onto the toolCall. */
  durationMs?: number | undefined;
  /** Assistant `thinking` blocks in this message. Count only: measured on
   *  forge-beta 2026-08-23, all 12,899 thinking blocks in 3 days carry an EMPTY
   *  `thinking` string (signature only), so there is no text to render — only
   *  the fact that the model paused here. */
  thinkingCount?: number | undefined;
  /** Present on the `result` message only. */
  totals?: RunTotals | undefined;
  usage?:
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;
}

/** The `result` line's totals. Claude Code emits `total_cost_usd`; `cost_usd`
 *  is the pre-2025 spelling and is still accepted so old transcripts re-derive
 *  unchanged. */
export interface RunTotals {
  totalCostUsd?: number | undefined;
  durationMs?: number | undefined;
  durationApiMs?: number | undefined;
  numTurns?: number | undefined;
  permissionDenials?: number | undefined;
  stopReason?: string | undefined;
  isError?: boolean | undefined;
}

export interface ParseResult {
  messages: AgentMessage[];
  sessionId?: string | undefined;
}

/** Monotonic id generator scoped to a single derive pass. */
export function createIdFactory(): () => string {
  let counter = 0;
  return () => `msg-${++counter}`;
}

function parseSystemMessage(
  data: Record<string, unknown>,
  timestamp: number,
  makeId: () => string,
): ParseResult {
  const subtype = (data.subtype as string) ?? undefined;
  const sessionId = subtype === 'init' ? (data.session_id as string | undefined) : undefined;
  return {
    messages: [
      {
        id: makeId(),
        type: 'system',
        timestamp,
        content: (data.message as string) ?? (subtype === 'init' ? 'Session started' : ''),
        subtype,
      },
    ],
    sessionId,
  };
}

function parseAssistantMessage(
  data: Record<string, unknown>,
  timestamp: number,
  makeId: () => string,
): ParseResult {
  const msg = data.message as Record<string, unknown> | undefined;
  const content = msg?.content as
    | Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>
    | undefined;
  if (!Array.isArray(content)) return { messages: [] };

  const blocks: ContentBlock[] = [];
  const toolCalls: ToolCall[] = [];
  const textParts: string[] = [];
  let thinkingCount = 0;

  for (const c of content) {
    if (c.type === 'thinking') {
      thinkingCount += 1;
    } else if (c.type === 'text') {
      const text = c.text ?? '';
      if (text) {
        blocks.push({ type: 'text', text });
        textParts.push(text);
      }
    } else if (c.type === 'tool_use' && c.name === 'TodoWrite') {
      processTodoBlock(c, blocks);
    } else if (c.type === 'tool_use') {
      processToolCall(c, blocks, toolCalls, makeId);
    }
  }

  const text = textParts.join('');
  const hasTodos = blocks.some((b) => b.type === 'todos');
  if (!text && toolCalls.length === 0 && !hasTodos && thinkingCount === 0) return { messages: [] };

  const message: AgentMessage = {
    id: makeId(),
    type: 'assistant',
    timestamp,
    content: text || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    blocks: blocks.length > 0 ? blocks : undefined,
    model: (msg?.model as string) ?? (data.model as string) ?? undefined,
    thinkingCount: thinkingCount > 0 ? thinkingCount : undefined,
    usage:
      (msg?.usage as AgentMessage['usage']) ?? (data.usage as AgentMessage['usage']) ?? undefined,
  };

  return { messages: [message] };
}

function processTodoBlock(c: { input?: unknown }, blocks: ContentBlock[]): void {
  const input = (c.input as Record<string, unknown>) ?? {};
  const rawTodos =
    (input.todos as { content: string; status: string; activeForm?: string }[]) ?? [];
  const existingIdx = blocks.findIndex((b) => b.type === 'todos');
  const todosBlock: ContentBlock = {
    type: 'todos',
    todos: rawTodos.map((t) => ({
      content: t.content,
      status: (t.status as 'pending' | 'in_progress' | 'completed') ?? 'pending',
      activeForm: t.activeForm,
    })),
  };
  if (existingIdx >= 0) {
    blocks[existingIdx] = todosBlock;
  } else {
    blocks.push(todosBlock);
  }
}

function processToolCall(
  c: { id?: string; name?: string; input?: unknown },
  blocks: ContentBlock[],
  toolCalls: ToolCall[],
  makeId: () => string,
): void {
  const tc: ToolCall = {
    id: (c.id as string) ?? makeId(),
    name: (c.name as string) ?? 'unknown',
    input: (c.input as Record<string, unknown>) ?? {},
  };
  blocks.push({ type: 'tool', toolCall: tc });
  toolCalls.push(tc);
}

/**
 * Parse a single stream-json line from Claude CLI into one or more
 * AgentMessages. Tool use/result are attached to the preceding assistant
 * message as toolCalls. Also builds interleaved ContentBlock[] for CLI-style
 * rendering. `makeId` supplies session-scoped ids (see createIdFactory).
 *
 * `timestamp` is the stamp applied to every emitted message. Callers that
 * re-derive a transcript (buildSessionFromEvents) MUST pass the originating
 * job_event's `ts` so output is deterministic across re-derives — otherwise a
 * default `Date.now()` would drift settled messages to re-parse time on every
 * flush (breaks idempotency + desktop parity).
 */
export function parseStreamMessages(
  raw: unknown,
  makeId: () => string,
  timestamp: number = Date.now(),
): ParseResult {
  const data = raw as Record<string, unknown>;
  if (!data || typeof data !== 'object' || !data.type) return { messages: [] };

  const type = data.type as string;

  if (type === 'system') {
    return parseSystemMessage(data, timestamp, makeId);
  }

  if (type === 'assistant') {
    return parseAssistantMessage(data, timestamp, makeId);
  }

  if (type === 'user') {
    return parseUserMessage(data, timestamp, makeId);
  }

  if (type === 'result') {
    return parseResultMessage(data, timestamp, makeId);
  }

  return { messages: [] };
}

function parseUserMessage(
  data: Record<string, unknown>,
  timestamp: number,
  makeId: () => string,
): ParseResult {
  const msg = data.message as Record<string, unknown> | undefined;
  const content = msg?.content as
    | Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }>
    | undefined;
  if (!Array.isArray(content)) return { messages: [] };

  const results = content.filter((c) => c.type === 'tool_result');
  if (results.length === 0) return { messages: [] };

  return {
    messages: results.map((r) => ({
      id: makeId(),
      type: 'tool_result' as const,
      timestamp,
      toolOutput: (r.content as string) ?? '',
      toolName: r.tool_use_id,
      isError: r.is_error === true ? true : undefined,
    })),
  };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// cm:guard read `total_cost_usd` FIRST — `cost_usd` is the pre-2025 key and was the only one this read, so every session since the rename ended on the string 'Agent finished.' with cost, duration, turn count and permission denials all discarded. Keep the fallback so old transcripts re-derive unchanged.
function parseResultMessage(
  data: Record<string, unknown>,
  timestamp: number,
  makeId: () => string,
): ParseResult {
  const totals: RunTotals = {
    totalCostUsd: num(data.total_cost_usd) ?? num(data.cost_usd),
    durationMs: num(data.duration_ms),
    durationApiMs: num(data.duration_api_ms),
    numTurns: num(data.num_turns),
    permissionDenials: Array.isArray(data.permission_denials)
      ? data.permission_denials.length
      : undefined,
    stopReason: typeof data.stop_reason === 'string' ? data.stop_reason : undefined,
    isError: data.is_error === true ? true : undefined,
  };
  const cost = totals.totalCostUsd;
  const content = cost !== undefined ? `Cost: $${cost.toFixed(4)}` : 'Agent finished.';
  return {
    messages: [{ id: makeId(), type: 'system', timestamp, content, subtype: 'result', totals }],
  };
}

/**
 * Merge parsed agent messages into an existing message list (mutates array).
 * Handles assistant continuation, tool_result attachment, and appending new
 * messages. Ported verbatim from desktop `session-tracker.ts::mergeMessages`.
 */
export function mergeMessages(messages: AgentMessage[], parsed: AgentMessage[]): void {
  for (const p of parsed) {
    const last = messages[messages.length - 1];

    if (p.type === 'assistant' && last?.type === 'assistant') {
      // Merge tool calls
      const oldTools = last.toolCalls ?? [];
      const newTools = p.toolCalls ?? [];
      const existingIds = new Set(oldTools.map((t) => t.id));
      const merged = [...oldTools, ...newTools.filter((t) => !existingIds.has(t.id))];

      // Merge content blocks
      const oldBlocks = last.blocks ?? [];
      const newBlocks = p.blocks ?? [];
      const existingToolIds = new Set(
        oldBlocks.filter((b) => b.type === 'tool').map((b) => b.toolCall?.id),
      );
      const mergedBlocks = [
        ...oldBlocks,
        ...newBlocks.filter(
          (b) => b.type === 'text' || (b.type === 'tool' && !existingToolIds.has(b.toolCall?.id)),
        ),
      ];

      messages[messages.length - 1] = {
        ...p,
        toolCalls: merged.length > 0 ? merged : undefined,
        blocks: mergedBlocks.length > 0 ? mergedBlocks : undefined,
      };
    } else if (p.type === 'tool_result' && last?.type === 'assistant' && last.toolCalls) {
      const toolId = p.toolName;
      const settled = (t: ToolCall): ToolCall => ({
        ...t,
        output: p.toolOutput,
        ...(p.isError === true ? { isError: true } : {}),
        ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
      });
      const newCalls = last.toolCalls.map((t) => (t.id === toolId ? settled(t) : t));
      const newBlocks = last.blocks?.map((b) =>
        b.type === 'tool' && b.toolCall && b.toolCall.id === toolId
          ? { ...b, toolCall: settled(b.toolCall) }
          : b,
      );
      messages[messages.length - 1] = { ...last, toolCalls: newCalls, blocks: newBlocks };
    } else {
      messages.push(p);
    }
  }
}

/** A persisted job_event row, narrowed to the fields the derive reads. */
export interface JobEventLike {
  kind: string;
  data: unknown;
  /** Persisted event time (job_events.ts). Used as the message timestamp so
   *  re-derives are deterministic; absent → falls back to Date.now(). */
  ts?: Date | string | number | null;
}

export interface DerivedSession {
  messages: AgentMessage[];
  claudeSessionId: string | null;
}

/** Coerce a job_event `ts` (Date | ISO string | epoch ms) to epoch ms, or
 *  undefined when absent/unparseable so parseStreamMessages keeps its default. */
function toEventTimestamp(ts: Date | string | number | null | undefined): number | undefined {
  if (ts == null) return undefined;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number') return ts;
  const ms = new Date(ts).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Re-derive the full session transcript from a job's ordered job_events.
 *
 * `stdout` events carry a raw Claude stream-json line under `data.line`
 * (see runner `dispatch.rs::map_event`); `progress` events may carry
 * `data.claudeSessionId`. The result is byte-equivalent to what the desktop
 * SessionTracker accumulates incrementally, so it is fully idempotent — the
 * same events always yield the same `AgentMessage[]` (a single id factory is
 * threaded across the whole pass).
 *
 * `events` MUST be ordered by seq (caller responsibility).
 */
export function buildSessionFromEvents(events: JobEventLike[]): DerivedSession {
  const makeId = createIdFactory();
  const messages: AgentMessage[] = [];
  let claudeSessionId: string | null = null;
  // cm:why a tool's duration is nowhere in the stream — the only record is the gap between the two job_events carrying its tool_use and its tool_result, which is why it is derived here and not in the parser.
  const startedAt = new Map<string, number>();

  for (const ev of events) {
    if (ev.kind === 'stdout') {
      const line = (ev.data as { line?: unknown } | null | undefined)?.line;
      if (line == null) continue;
      const ts = toEventTimestamp(ev.ts);
      const { messages: parsed, sessionId } = parseStreamMessages(line, makeId, ts);
      if (sessionId) claudeSessionId = sessionId;
      for (const p of parsed) {
        if (ts === undefined) continue;
        if (p.type === 'assistant') {
          for (const tc of p.toolCalls ?? []) if (!startedAt.has(tc.id)) startedAt.set(tc.id, ts);
        } else if (p.type === 'tool_result' && p.toolName) {
          const began = startedAt.get(p.toolName);
          if (began !== undefined && ts >= began) p.durationMs = ts - began;
        }
      }
      if (parsed.length > 0) mergeMessages(messages, parsed);
    } else if (ev.kind === 'progress') {
      const sid = (ev.data as { claudeSessionId?: unknown } | null | undefined)?.claudeSessionId;
      if (typeof sid === 'string' && sid.length > 0) claudeSessionId = sid;
    }
  }

  return { messages, claudeSessionId };
}
