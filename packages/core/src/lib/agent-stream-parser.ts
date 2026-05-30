/**
 * Port of the desktop Claude stream-json parser (`packages/dev/src/lib/
 * stream-parser.ts` + the `mergeMessages` helper from `session-tracker.ts`).
 *
 * Why a server-side copy (ISS-283): the `forge-runner` CLI authenticates with
 * a device token only and cannot call the user-JWT-gated
 * `PATCH /api/agent-sessions/:id` the desktop uses. But the runner already
 * streams every raw Claude stream-json line to core as a `stdout` job_event,
 * so core holds the full transcript. Core therefore derives the canonical
 * `agent_sessions.messages` from those events using this parser, so CLI-run
 * sessions render identically to desktop-run ones.
 *
 * Kept byte-faithful to the desktop parser so the web `AgentMessage[]` renderer
 * produces the same output for both origins. The ONLY intentional change: the
 * desktop `messageCounter` was a module-level mutable — non-deterministic in a
 * multi-session server — so id generation is externalised into a per-derive
 * factory (`createIdFactory`). IDs only need to be unique within one session's
 * message array, which `buildSessionFromEvents` guarantees by threading a
 * single factory through one full re-derive.
 */

// Optional fields carry explicit `| undefined` because core compiles with
// `exactOptionalPropertyTypes: true` (the desktop source does not) and the
// parser assigns `undefined` to several of these by design.
export interface ToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown> | undefined;
  output?: string | undefined;
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
  usage?:
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;
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

  for (const c of content) {
    if (c.type === 'text') {
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
  if (!text && toolCalls.length === 0 && !hasTodos) return { messages: [] };

  const message: AgentMessage = {
    id: makeId(),
    type: 'assistant',
    timestamp,
    content: text || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    blocks: blocks.length > 0 ? blocks : undefined,
    model: (msg?.model as string) ?? (data.model as string) ?? undefined,
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
 */
export function parseStreamMessages(raw: unknown, makeId: () => string): ParseResult {
  const data = raw as Record<string, unknown>;
  if (!data || typeof data !== 'object' || !data.type) return { messages: [] };

  const type = data.type as string;
  const timestamp = Date.now();

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
    })),
  };
}

function parseResultMessage(
  data: Record<string, unknown>,
  timestamp: number,
  makeId: () => string,
): ParseResult {
  const cost = data.cost_usd as number | undefined;
  const content = cost !== undefined ? `Cost: $${cost.toFixed(4)}` : 'Agent finished.';
  return {
    messages: [{ id: makeId(), type: 'system', timestamp, content }],
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
      const newCalls = last.toolCalls.map((t) =>
        t.id === toolId ? { ...t, output: p.toolOutput } : t,
      );
      const newBlocks = last.blocks?.map((b) =>
        b.type === 'tool' && b.toolCall?.id === toolId
          ? { ...b, toolCall: { ...b.toolCall!, output: p.toolOutput } }
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
}

export interface DerivedSession {
  messages: AgentMessage[];
  claudeSessionId: string | null;
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

  for (const ev of events) {
    if (ev.kind === 'stdout') {
      const line = (ev.data as { line?: unknown } | null | undefined)?.line;
      if (line == null) continue;
      const { messages: parsed, sessionId } = parseStreamMessages(line, makeId);
      if (sessionId) claudeSessionId = sessionId;
      if (parsed.length > 0) mergeMessages(messages, parsed);
    } else if (ev.kind === 'progress') {
      const sid = (ev.data as { claudeSessionId?: unknown } | null | undefined)?.claudeSessionId;
      if (typeof sid === 'string' && sid.length > 0) claudeSessionId = sid;
    }
  }

  return { messages, claudeSessionId };
}
