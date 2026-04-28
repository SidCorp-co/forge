import type { AgentMessage, ContentBlock, ToolCall } from "./types";

let messageCounter = 0;

function makeId(): string {
  return `msg-${++messageCounter}`;
}

function parseSystemMessage(data: Record<string, unknown>, timestamp: number): ParseResult {
  const subtype = (data.subtype as string) ?? undefined;
  const sessionId = subtype === "init" ? (data.session_id as string | undefined) : undefined;
  return {
    messages: [
      {
        id: makeId(),
        type: "system",
        timestamp,
        content: (data.message as string) ?? (subtype === "init" ? "Session started" : ""),
        subtype,
      },
    ],
    sessionId,
  };
}

function parseAssistantMessage(data: Record<string, unknown>, timestamp: number): ParseResult {
  const msg = data.message as Record<string, unknown> | undefined;
  const content = msg?.content as Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }> | undefined;
  if (!Array.isArray(content)) return { messages: [] };

  const blocks: ContentBlock[] = [];
  const toolCalls: ToolCall[] = [];
  const textParts: string[] = [];

  for (const c of content) {
    if (c.type === "text") {
      const text = c.text ?? "";
      if (text) {
        blocks.push({ type: "text", text });
        textParts.push(text);
      }
    } else if (c.type === "tool_use" && c.name === "TodoWrite") {
      processTodoBlock(c, blocks);
    } else if (c.type === "tool_use") {
      processToolCall(c, blocks, toolCalls);
    }
  }

  const text = textParts.join("");
  const hasTodos = blocks.some((b) => b.type === "todos");
  if (!text && toolCalls.length === 0 && !hasTodos) return { messages: [] };

  const message: AgentMessage = {
    id: makeId(),
    type: "assistant",
    timestamp,
    content: text || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    blocks: blocks.length > 0 ? blocks : undefined,
    model: (msg?.model as string) ?? (data.model as string) ?? undefined,
    usage: (msg?.usage as AgentMessage["usage"]) ?? (data.usage as AgentMessage["usage"]) ?? undefined,
  };

  return { messages: [message] };
}

function processTodoBlock(c: { input?: unknown }, blocks: ContentBlock[]): void {
  const input = (c.input as Record<string, unknown>) ?? {};
  const rawTodos = (input.todos as { content: string; status: string; activeForm?: string }[]) ?? [];
  const existingIdx = blocks.findIndex((b) => b.type === "todos");
  const todosBlock: ContentBlock = {
    type: "todos",
    todos: rawTodos.map((t) => ({
      content: t.content,
      status: (t.status as "pending" | "in_progress" | "completed") ?? "pending",
      activeForm: t.activeForm,
    })),
  };
  if (existingIdx >= 0) {
    blocks[existingIdx] = todosBlock;
  } else {
    blocks.push(todosBlock);
  }
}

function processToolCall(c: { id?: string; name?: string; input?: unknown }, blocks: ContentBlock[], toolCalls: ToolCall[]): void {
  const tc: ToolCall = {
    id: (c.id as string) ?? makeId(),
    name: (c.name as string) ?? "unknown",
    input: (c.input as Record<string, unknown>) ?? {},
  };
  blocks.push({ type: "tool", toolCall: tc });
  toolCalls.push(tc);
}

export interface ParseResult {
  messages: AgentMessage[];
  sessionId?: string;
}

/**
 * Parse a single stream-json line from Claude CLI into one or more AgentMessages.
 * Tool use/result are attached to the preceding assistant message as toolCalls.
 * Also builds interleaved ContentBlock[] for CLI-style rendering.
 */
export function parseStreamMessages(raw: unknown): ParseResult {
  const data = raw as Record<string, unknown>;
  if (!data || typeof data !== "object" || !data.type) return { messages: [] };

  const type = data.type as string;
  const timestamp = Date.now();

  if (type === "system") {
    return parseSystemMessage(data, timestamp);
  }

  if (type === "assistant") {
    return parseAssistantMessage(data, timestamp);
  }

  if (type === "user") {
    return parseUserMessage(data, timestamp);
  }

  if (type === "result") {
    return parseResultMessage(data, timestamp);
  }

  return { messages: [] };
}

function parseUserMessage(data: Record<string, unknown>, timestamp: number): ParseResult {
  const msg = data.message as Record<string, unknown> | undefined;
  const content = msg?.content as Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }> | undefined;
  if (!Array.isArray(content)) return { messages: [] };

  const results = content.filter((c) => c.type === "tool_result");
  if (results.length === 0) return { messages: [] };

  return {
    messages: results.map((r) => ({
      id: makeId(),
      type: "tool_result" as const,
      timestamp,
      toolOutput: (r.content as string) ?? "",
      toolName: r.tool_use_id,
    })),
  };
}

function parseResultMessage(data: Record<string, unknown>, timestamp: number): ParseResult {
  const cost = data.cost_usd as number | undefined;
  const content = cost !== undefined ? `Cost: $${cost.toFixed(4)}` : "Agent finished.";
  return {
    messages: [
      { id: makeId(), type: "system", timestamp, content },
    ],
  };
}
