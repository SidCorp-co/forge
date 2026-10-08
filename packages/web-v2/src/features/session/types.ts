import { type Copy, productCopy } from "@/lib/i18n/product-copy";
import { decodeToolOutput } from "./result-summary";

/** A single tool invocation as serialized by the runner. */
export interface ToolCallData {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  result?: unknown;
  durationMs?: number;
  isError?: boolean;
}

export interface AgentTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

/**
 * A tool call as serialized on the canonical block. Differs from the render-ready
 * `ToolCallData` in two field names: the captured output lives on `output`
 * (string) rather than `result`. Normalize via `result ?? output` when mapping.
 */
export interface CanonicalToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  output?: string;
  result?: unknown;
  durationMs?: number;
  isError?: boolean;
}

/**
 * The canonical content block written by the transcript derive
 * (`packages/core/src/lib/agent-stream-parser.ts`).
 */
export type CanonicalBlock =
  | { type: "text"; text?: string }
  | { type: "tool"; toolCall?: CanonicalToolCall }
  | { type: "todos"; todos?: AgentTodo[] }
  | { type: "thinking"; thinking?: string; durationMs?: number }
  // Structured messages a service writes (ISS-63), drawn by features/onboarding, never by the session renderer.
  | { type: "questionnaire" | "questionnaire_answers"; batchId?: string }
  | { type: "designs"; designs?: { heading: string; workflowIds: string[]; approve?: boolean } }
  // A report block a service wrote, drawn through features/visual-blocks, and a stored entry core did not know, kept so it can be named.
  | { type: "visual"; visual?: unknown }
  | { type: "unsupported"; unsupported?: string };

/** A file attached to a chat user turn (ISS-499). Same `{id,name,mime,size,url}`
 * shape the shared `AttachmentList` renderer accepts. */
export interface SessionAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

export interface RunTotals {
  totalCostUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  permissionDenials?: number;
  stopReason?: string;
  isError?: boolean;
}

/**
 * One transcript entry, in the one shape every producer writes. Stored at
 * `agent_session_turns.content.value` (turns path) or directly in
 * `agent_sessions.messages` (messages fallback).
 */
export interface MessageEntry {
  id?: string;
  /** What this entry is. */
  type?: "user" | "assistant" | "tool" | "system" | "tool_use" | "tool_result";
  content?: unknown;
  timestamp?: number;
  toolCalls?: ToolCallData[];
  /** Ordered canonical blocks. */
  blocks?: CanonicalBlock[];
  /** Files the user attached to this turn (ISS-499); persisted on the user message. */
  attachments?: SessionAttachment[];
  /** Assistant `thinking` blocks in this turn. A count, not text — every
   *  thinking block Claude Code emits carries an empty string. */
  thinkingCount?: number;
  /** Run totals, on the final result entry only. */
  totals?: RunTotals;
  subtype?: string;
}

export type TurnRole = "user" | "assistant" | "tool";

export interface TurnRow {
  id: string;
  agentSessionId: string;
  turnIndex: number;
  role: TurnRole;
  content: { value?: MessageEntry } | MessageEntry | null;
  editedAt: string | null;
  createdAt: string;
}

/** `GET /:id/turns` envelope. */
export interface TurnsResponse {
  turns: TurnRow[];
  nextCursor: string | null;
}

/** A block ready to render inside an agent turn. */
export type RenderBlock =
  | { type: "text"; text: string }
  | { type: "tool"; tool: ToolCallData }
  | { type: "todos"; todos: AgentTodo[] }
  | { type: "thinking"; text?: string; durationMs?: number; count?: number }
  | { type: "visual"; block: unknown }
  | { type: "unsupported"; name: string };

/**
 * A flattened, render-ready conversation entry. Each persisted turn maps to
 * exactly one item: user turns become `prompt` (editable / regen / fork
 * anchor), everything else becomes `agent` carrying ordered render blocks.
 */
export interface ConversationItem {
  id: string;
  turnId: string;
  turnIndex: number;
  role: TurnRole;
  kind: "prompt" | "agent";
  /** Prompt text (kind === 'prompt'). */
  text: string;
  /** Ordered render blocks (kind === 'agent'). */
  blocks: RenderBlock[];
  /** Files attached to a user prompt (ISS-499); empty for agent turns. */
  attachments: SessionAttachment[];
  timestamp?: number;
  editedAt: string | null;
  /** Thinking pauses inside this turn (count only — the text is always empty). */
  thinkingCount: number;
}

/** Coarse tool classification driving the tool-card layout. */
export type ToolKind = "edit" | "read" | "search" | "run" | "task" | "generic";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function toolKind(name: string): ToolKind {
  if (EDIT_TOOLS.has(name)) return "edit";
  if (name === "Read") return "read";
  if (name === "Grep" || name === "Glob") return "search";
  if (name === "Bash") return "run";
  if (name === "Task" || name === "Skill") return "task";
  return "generic";
}

/* ----------------------------- tool labels ------------------------------ */

function formatMcpLabel(name: string, input: Record<string, unknown>): string {
  const toolName = name.replace(/^mcp__[^_]+__/, "");
  const action = (input.action as string) ?? "";
  const id = (input.uuid as string) ?? (input.documentId as string) ?? "";
  const detail = id ? `(${id.slice(0, 8)})` : action ? `(${action})` : "";
  switch (toolName) {
    case "forge_issues":
      if (action === "get" || action === "update")
        return `Issue${id ? `(${id.slice(0, 8)})` : `(${action})`}`;
      return `Issues(${action || "list"})`;
    case "forge_comments":
      return `Comment(${action || "list"})`;
    case "forge_memory":
      return "Memory";
    case "forge_skills":
      return "Skills";
    default: {
      const label = toolName.replace(/_/g, " ");
      return `${label.charAt(0).toUpperCase() + label.slice(1)}${detail}`;
    }
  }
}

export function getToolLabel(tc: ToolCallData, t: Copy = productCopy()): string {
  const input = tc.input ?? {};
  const filePath = (input.file_path as string) ?? "";
  switch (tc.name) {
    case "Edit":
    case "MultiEdit":
      return t("sessions.tool.updated", { file: filePath });
    case "Write":
      return t("sessions.tool.created", { file: filePath });
    case "Read":
      return t("sessions.tool.read", { file: filePath });
    case "Bash":
      return t("sessions.tool.ran", { command: ((input.command as string) ?? "").slice(0, 80) });
    case "Grep":
      return input.path
        ? t("sessions.tool.searchedIn", { pattern: (input.pattern as string) ?? "", path: String(input.path) })
        : t("sessions.tool.searched", { pattern: (input.pattern as string) ?? "" });
    case "Glob":
      return t("sessions.tool.found", { pattern: (input.pattern as string) ?? "" });
    case "TodoWrite":
      return t("sessions.tool.taskList");
    case "Task":
      return t("sessions.tool.agent", { what: (input.description as string) ?? (input.subagent_type as string) ?? t("sessions.tool.subtask") });
    case "Skill":
      return t("sessions.tool.skill", { what: (input.skill as string) ?? t("sessions.tool.unknown") });
    default:
      return tc.name.startsWith("mcp__") ? formatMcpLabel(tc.name, input) : tc.name;
  }
}

/* --------------------------- block derivation --------------------------- */

function todoWriteToTodos(input: Record<string, unknown> | undefined): RenderBlock {
  const raw = (input?.todos as AgentTodo[] | undefined) ?? [];
  return {
    type: "todos",
    todos: raw.map((t) => ({
      content: t.content,
      status: (t.status as AgentTodo["status"]) ?? "pending",
      activeForm: t.activeForm,
    })),
  };
}

/** Keep only the last todos block (the runner re-emits the full list each time). */
function dedupeTodos(blocks: RenderBlock[]): RenderBlock[] {
  let lastIdx = -1;
  blocks.forEach((b, i) => {
    if (b.type === "todos") lastIdx = i;
  });
  if (lastIdx < 0) return blocks;
  return blocks.filter((b, i) => b.type !== "todos" || i === lastIdx);
}

function entryText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" ? ((b as { text?: string }).text ?? "") : String(b)))
      .join("");
  }
  return "";
}

/** Unwrap the `{ value }` wrapper (older/forked rows may store the entry flat). */
function unwrapEntry(content: TurnRow["content"]): MessageEntry {
  if (content && typeof content === "object" && "value" in content && content.value) {
    return content.value as MessageEntry;
  }
  return (content as MessageEntry) ?? { role: "assistant" };
}

/** Map a canonical runner `toolCall` to the render-ready `ToolCallData`
 *  (field drift: the captured output lives on `output`, not `result`). */
function toToolCallData(tc: CanonicalToolCall): ToolCallData {
  return {
    id: tc.id,
    name: tc.name,
    input: tc.input,
    result: tc.result !== undefined ? tc.result : decodeToolOutput(tc.output),
    durationMs: tc.durationMs,
    isError: tc.isError,
  };
}

const STRUCTURED_ELSEWHERE: ReadonlySet<string> = new Set(["questionnaire", "questionnaire_answers", "designs"]);

function assistantBlocks(entry: MessageEntry): RenderBlock[] {
  const out: RenderBlock[] = [];
  if (entry.blocks?.length) {
    // Canonical CLI-runner shape: ordered text/tool/todos blocks. Preserving
    // order keeps assistant text interleaved between tool calls (ISS-348).
    for (const b of entry.blocks) {
      if (b.type === "tool" && b.toolCall) {
        const tool = toToolCallData(b.toolCall);
        out.push(tool.name === "TodoWrite" ? todoWriteToTodos(tool.input) : { type: "tool", tool });
      } else if (b.type === "todos") {
        out.push({ type: "todos", todos: b.todos ?? [] });
      } else if (b.type === "thinking") {
        out.push({
          type: "thinking",
          ...(b.thinking ? { text: b.thinking } : {}),
          ...(b.durationMs !== undefined ? { durationMs: b.durationMs } : {}),
        });
      } else if (b.type === "text") {
        if (b.text) out.push({ type: "text", text: b.text });
      } else if (b.type === "visual") {
        out.push({ type: "visual", block: b.visual });
      } else if (STRUCTURED_ELSEWHERE.has(b.type)) {
        // a questionnaire, its answers and a designs list are drawn by features/onboarding, off the thread's live data
      } else {
        // a stored block of a kind this screen does not know is named, never left out
        const named = b.type === "unsupported" ? b.unsupported : b.type;
        out.push({ type: "unsupported", name: typeof named === "string" && named !== "" ? named : "nameless" });
      }
    }
  } else {
    if (entry.toolCalls?.length) {
      for (const tc of entry.toolCalls) {
        out.push(
          tc.name === "TodoWrite"
            ? todoWriteToTodos(tc.input)
            : { type: "tool", tool: toToolCallData(tc) },
        );
      }
    }
    const text = entryText(entry.content);
    if (text) out.push({ type: "text", text });
  }
  return withPauseCount(entry, dedupeTodos(out));
}

/**
 * The turn's pauses that carried no readable text, as the same render block.
 */
function withPauseCount(entry: MessageEntry, blocks: RenderBlock[]): RenderBlock[] {
  const count = entry.thinkingCount ?? 0;
  if (count <= 0) return blocks;
  return [{ type: "thinking", count }, ...blocks];
}

/**
 * Role decision for an entry, off the canonical `type`: `user` → prompt,
 * `assistant` → agent, everything else → tool.
 */
function entryRole(entry: MessageEntry): TurnRole {
  if (entry.type === "user") return "user";
  if (entry.type === "assistant") return "assistant";
  return "tool";
}

export function parseTurns(turns: TurnRow[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const turn of turns) {
    const entry = unwrapEntry(turn.content);
    const role = turn.role;
    if (role === "user") {
      const text = entryText(entry.content);
      const attachments = entry.attachments ?? [];
      if (!text && attachments.length === 0) continue;
      items.push({
        id: turn.id,
        turnId: turn.id,
        turnIndex: turn.turnIndex,
        role,
        kind: "prompt",
        text,
        blocks: [],
        attachments,
        timestamp: entry.timestamp,
        editedAt: turn.editedAt,
        thinkingCount: entry.thinkingCount ?? 0,
      });
    } else {
      const blocks = assistantBlocks(entry);
      if (blocks.length === 0) continue;
      items.push({
        id: turn.id,
        turnId: turn.id,
        turnIndex: turn.turnIndex,
        role,
        kind: "agent",
        text: "",
        blocks,
        attachments: [],
        timestamp: entry.timestamp,
        editedAt: turn.editedAt,
        thinkingCount: entry.thinkingCount ?? 0,
      });
    }
  }
  return items;
}

export function parseMessages(messages: unknown[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  messages.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const entry = raw as MessageEntry;
    const role = entryRole(entry);
    const id = entry.id ?? `msg-${index}`;
    if (role === "user") {
      const text = entryText(entry.content);
      const attachments = entry.attachments ?? [];
      if (!text && attachments.length === 0) return;
      items.push({
        id,
        turnId: "",
        turnIndex: index,
        role,
        kind: "prompt",
        text,
        blocks: [],
        attachments,
        timestamp: entry.timestamp,
        editedAt: null,
        thinkingCount: entry.thinkingCount ?? 0,
      });
    } else {
      const blocks = assistantBlocks(entry);
      if (blocks.length === 0) return;
      items.push({
        id,
        turnId: "",
        turnIndex: index,
        role,
        kind: "agent",
        text: "",
        blocks,
        attachments: [],
        timestamp: entry.timestamp,
        editedAt: null,
        thinkingCount: entry.thinkingCount ?? 0,
      });
    }
  });
  return items;
}
