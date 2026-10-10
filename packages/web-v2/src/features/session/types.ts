import type { ExecutionFacts } from "@forge/contracts/report-executions";
import type { ReportRunFacts } from "@forge/contracts/report-queries";
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
  /** Its input and output were the asker's and were not sent to this reader. */
  withheld?: true;
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
  /**
   * Core took its input and output out: the reply's turn ran as another member, whose calls are
   * theirs (`packages/core/src/conversations/tool-content.ts`).
   */
  withheld?: true;
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
  // A report block a service wrote with the query and read time of its run (or, computed, the execution it came from), drawn through features/visual-blocks, and a stored entry core did not know, kept so it can be named.
  | { type: "visual"; visual?: unknown; run?: ReportRunFacts; execution?: ExecutionFacts }
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

/** Coarse tool classification driving how a tool call is drawn. */
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
        ? t("sessions.tool.searchedIn", { pattern: (input.pattern as string) ?? "", path: typeof input.path === "string" ? input.path : JSON.stringify(input.path) })
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
      status: (t.status) ?? "pending",
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
    return content.value;
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
    ...(tc.withheld ? { withheld: true as const } : {}),
  };
}

const STRUCTURED_ELSEWHERE: ReadonlySet<string> = new Set(["questionnaire", "questionnaire_answers", "designs"]);

type StoredBlock = NonNullable<MessageEntry["blocks"]>[number];

/** One stored block as the blocks it renders as: none for one drawn elsewhere, a named stand-in for one this screen does not know. */
function renderBlock(b: StoredBlock): RenderBlock | null {
  switch (b.type) {
    case "tool": {
      if (!b.toolCall) return null;
      const tool = toToolCallData(b.toolCall);
      return tool.name === "TodoWrite" ? todoWriteToTodos(tool.input) : { type: "tool", tool };
    }
    case "todos":
      return { type: "todos", todos: b.todos ?? [] };
    case "thinking":
      return {
        type: "thinking",
        ...(b.thinking ? { text: b.thinking } : {}),
        ...(b.durationMs !== undefined ? { durationMs: b.durationMs } : {}),
      };
    case "text":
      return b.text ? { type: "text", text: b.text } : null;
    case "visual":
      return { type: "visual", block: b.visual };
    default: {
      // a questionnaire, its answers and a designs list are drawn by features/onboarding, off the thread's live data
      if (STRUCTURED_ELSEWHERE.has(b.type)) return null;
      // a stored block of a kind this screen does not know is named, never left out
      const named = b.type === "unsupported" ? b.unsupported : b.type;
      return { type: "unsupported", name: typeof named === "string" && named !== "" ? named : "nameless" };
    }
  }
}

/** The older flat shape: tool calls, then the entry's text. */
function flatBlocks(entry: MessageEntry): RenderBlock[] {
  const out: RenderBlock[] = (entry.toolCalls ?? []).map((tc) =>
    tc.name === "TodoWrite" ? todoWriteToTodos(tc.input) : { type: "tool", tool: toToolCallData(tc) },
  );
  const text = entryText(entry.content);
  if (text) out.push({ type: "text", text });
  return out;
}

function assistantBlocks(entry: MessageEntry): RenderBlock[] {
  // Canonical CLI-runner shape: ordered text/tool/todos blocks. Preserving
  // order keeps assistant text interleaved between tool calls (ISS-348).
  const out = entry.blocks?.length
    ? entry.blocks.map(renderBlock).filter((b): b is RenderBlock => b !== null)
    : flatBlocks(entry);
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

/** One entry as a thread item: a prompt with its text and files, or the agent's blocks; null when it carries nothing to draw. */
function entryItem(entry: MessageEntry, role: TurnRole, at: { id: string; turnId: string; turnIndex: number; editedAt: string | null }): ConversationItem | null {
  const prompt = role === "user";
  const text = prompt ? entryText(entry.content) : "";
  const attachments = prompt ? (entry.attachments ?? []) : [];
  const blocks = prompt ? [] : assistantBlocks(entry);
  if (prompt ? !text && attachments.length === 0 : blocks.length === 0) return null;
  return { ...at, role, kind: prompt ? "prompt" : "agent", text, blocks, attachments, timestamp: entry.timestamp, thinkingCount: entry.thinkingCount ?? 0 };
}

const drawn = (items: (ConversationItem | null)[]) => items.filter((i): i is ConversationItem => i !== null);

export function parseTurns(turns: TurnRow[]): ConversationItem[] {
  return drawn(turns.map((turn) => entryItem(unwrapEntry(turn.content), turn.role, { id: turn.id, turnId: turn.id, turnIndex: turn.turnIndex, editedAt: turn.editedAt })));
}

export function parseMessages(messages: unknown[]): ConversationItem[] {
  return drawn(
    messages.map((raw, index) => {
      if (!raw || typeof raw !== "object") return null;
      const entry = raw as MessageEntry;
      return entryItem(entry, entryRole(entry), { id: entry.id ?? `msg-${index}`, turnId: "", turnIndex: index, editedAt: null });
    }),
  );
}
