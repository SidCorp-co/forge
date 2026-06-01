// web-v2 feature module: session (singular — the run-conversation detail
// surface). Kept separate from the plural `features/sessions/` index/queue to
// avoid query-key + component name collisions (ISS-292).
//
// Types mirror the per-turn rows returned by `GET /api/agent-sessions/:id/turns`
// (`packages/core/src/agent-sessions/turns-helpers.ts loadTurns` → raw
// `agent_session_turns` rows) and the runner `messageEntry` stored at
// `content.value`. The block-derivation + tool-label + inline-diff logic is
// ported from v1 (`packages/web/src/components/chat/chat-message/*` +
// `hooks/use-agent-session-api.ts parseStoredMessages`) so both UIs agree.
//
// `@forge/contracts` has no agent-session-turn types yet, so these are re-typed
// locally (same note as ISS-291's `features/sessions/types.ts`).

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

/** Structured content blocks within an assistant message entry (v1 desktop shape). */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; tool: ToolCallData }
  | { type: "todos"; todos: AgentTodo[] };

/**
 * A tool call as serialized on the canonical runner block. Differs from the v1
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
 * The canonical content block written by the CLI-runner transcript derive
 * (`packages/core/src/lib/agent-stream-parser.ts`). Note the field drift vs the
 * v1 `ContentBlock`: `tool` (not `tool_use`), `toolCall` (not `tool`).
 */
export type CanonicalBlock =
  | { type: "text"; text?: string }
  | { type: "tool"; toolCall?: CanonicalToolCall }
  | { type: "todos"; todos?: AgentTodo[] };

/**
 * A message entry. Two shapes coexist:
 *   - desktop / edited turns: `role` + `contentBlocks`/`toolCalls` + `content`;
 *   - CLI-runner derive: `type` + ordered `blocks` (+ `content` for plain text).
 * Stored at `agent_session_turns.content.value` (turns path) or directly in
 * `agent_sessions.messages` (messages fallback).
 */
export interface MessageEntry {
  id?: string;
  role?: "user" | "assistant" | "tool" | "system";
  /** Canonical entry kind (CLI-runner shape) when `role` is absent. */
  type?: "user" | "assistant" | "tool" | "system" | "tool_use" | "tool_result";
  content?: unknown;
  timestamp?: number;
  toolCalls?: ToolCallData[];
  contentBlocks?: ContentBlock[];
  /** Ordered canonical blocks (CLI-runner shape). */
  blocks?: CanonicalBlock[];
}

export type TurnRole = "user" | "assistant" | "tool";

/** Raw `agent_session_turns` row (`content` wraps the entry as `{ value }`). */
export interface TurnRow {
  id: string;
  agentSessionId: string;
  turnIndex: number;
  role: TurnRole;
  content: { value?: MessageEntry } | MessageEntry | null;
  parentTurnId?: string | null;
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
  | { type: "todos"; todos: AgentTodo[] };

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
  timestamp?: number;
  editedAt: string | null;
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

/** Human label for a tool call — ported from v1 `tool-label.ts`. */
export function getToolLabel(tc: ToolCallData): string {
  const input = tc.input ?? {};
  const filePath = (input.file_path as string) ?? "";
  switch (tc.name) {
    case "Edit":
    case "MultiEdit":
      return `Updated ${filePath}`;
    case "Write":
      return `Created ${filePath}`;
    case "Read":
      return `Read ${filePath}`;
    case "Bash":
      return `Ran ${((input.command as string) ?? "").slice(0, 80)}`;
    case "Grep":
      return `Searched ${(input.pattern as string) ?? ""}${input.path ? ` in ${input.path}` : ""}`;
    case "Glob":
      return `Found ${(input.pattern as string) ?? ""}`;
    case "TodoWrite":
      return "Updated task list";
    case "Task":
      return `Agent: ${(input.description as string) ?? (input.subagent_type as string) ?? "subtask"}`;
    case "Skill":
      return `Skill: ${(input.skill as string) ?? "unknown"}`;
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
    result: tc.result ?? tc.output,
    durationMs: tc.durationMs,
    isError: tc.isError,
  };
}

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
      } else if (b.type === "text" && b.text) {
        out.push({ type: "text", text: b.text });
      }
    }
  } else if (entry.contentBlocks?.length) {
    for (const b of entry.contentBlocks) {
      if (b.type === "tool_use") {
        out.push(
          b.tool.name === "TodoWrite"
            ? todoWriteToTodos(b.tool.input)
            : { type: "tool", tool: b.tool },
        );
      } else if (b.type === "todos") {
        out.push({ type: "todos", todos: b.todos });
      } else if (b.type === "text" && b.text) {
        out.push({ type: "text", text: b.text });
      }
    }
  } else {
    if (entry.toolCalls?.length) {
      for (const tc of entry.toolCalls) {
        out.push(tc.name === "TodoWrite" ? todoWriteToTodos(tc.input) : { type: "tool", tool: tc });
      }
    }
    const text = entryText(entry.content);
    if (text) out.push({ type: "text", text });
  }
  return dedupeTodos(out);
}

/** Role decision for an entry: prefer the explicit `role`, else the canonical
 *  `type` (`user` → prompt; everything else → agent). */
function entryRole(entry: MessageEntry): TurnRole {
  if (entry.role) return entry.role === "user" ? "user" : entry.role === "assistant" ? "assistant" : "tool";
  if (entry.type === "user") return "user";
  if (entry.type === "assistant") return "assistant";
  return "tool";
}

/**
 * Flatten persisted turn rows into render-ready conversation items. User turns
 * become editable prompts; assistant/tool turns become agent rows with ordered
 * blocks. Empty turns (no text, no tools, no todos) are dropped.
 */
export function parseTurns(turns: TurnRow[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const turn of turns) {
    const entry = unwrapEntry(turn.content);
    const role = turn.role;
    if (role === "user") {
      const text = entryText(entry.content);
      if (!text) continue;
      items.push({
        id: turn.id,
        turnId: turn.id,
        turnIndex: turn.turnIndex,
        role,
        kind: "prompt",
        text,
        blocks: [],
        timestamp: entry.timestamp,
        editedAt: turn.editedAt,
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
        timestamp: entry.timestamp,
        editedAt: turn.editedAt,
      });
    }
  }
  return items;
}

/**
 * Flatten the canonical `agent_sessions.messages` array (returned in full by
 * `GET /api/agent-sessions/:id`) into render-ready items — the read-only
 * fallback for pipeline/CLI-runner sessions whose `/turns` table is empty
 * (ISS-348). Reuses the same per-entry logic as `parseTurns`; items carry a
 * synthetic stable id and no live `turnId` (edit/regen/fork are disabled by the
 * screen when rendering from messages). Empty entries are dropped.
 */
export function parseMessages(messages: unknown[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  messages.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const entry = raw as MessageEntry;
    const role = entryRole(entry);
    const id = entry.id ?? `msg-${index}`;
    if (role === "user") {
      const text = entryText(entry.content);
      if (!text) return;
      items.push({
        id,
        turnId: "",
        turnIndex: index,
        role,
        kind: "prompt",
        text,
        blocks: [],
        timestamp: entry.timestamp,
        editedAt: null,
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
        timestamp: entry.timestamp,
        editedAt: null,
      });
    }
  });
  return items;
}

/* ----------------------------- file diffs ------------------------------- */

export interface DiffHunk {
  oldLines: string[];
  newLines: string[];
}

export interface FileDiff {
  path: string;
  isNew: boolean;
  hunks: DiffHunk[];
  /** Added / removed line counts (sum across hunks). */
  added: number;
  removed: number;
}

function pushEdit(map: Map<string, FileDiff>, path: string, oldStr: string, newStr: string): void {
  if (!oldStr && !newStr) return;
  const existing = map.get(path) ?? { path, isNew: false, hunks: [], added: 0, removed: 0 };
  existing.hunks.push({ oldLines: oldStr ? oldStr.split("\n") : [], newLines: newStr ? newStr.split("\n") : [] });
  map.set(path, existing);
}

function collectFromTool(map: Map<string, FileDiff>, tc: ToolCallData): void {
  const input = tc.input ?? {};
  const path = (input.file_path as string) ?? "";
  if (!path) return;
  if (tc.name === "Edit" || tc.name === "NotebookEdit") {
    pushEdit(map, path, (input.old_string as string) ?? "", (input.new_string as string) ?? "");
  } else if (tc.name === "MultiEdit") {
    const edits = (input.edits as { old_string?: string; new_string?: string }[]) ?? [];
    for (const e of edits) pushEdit(map, path, e.old_string ?? "", e.new_string ?? "");
  } else if (tc.name === "Write") {
    const content = (input.content as string) ?? (typeof tc.result === "string" ? tc.result : "") ?? "";
    if (!content) return;
    const d = map.get(path) ?? { path, isNew: true, hunks: [], added: 0, removed: 0 };
    d.isNew = true;
    d.hunks = [{ oldLines: [], newLines: content.split("\n") }];
    map.set(path, d);
  }
}

function finalizeCounts(map: Map<string, FileDiff>): FileDiff[] {
  return Array.from(map.values()).map((d) => ({
    ...d,
    added: d.hunks.reduce((s, h) => s + h.newLines.length, 0),
    removed: d.hunks.reduce((s, h) => s + h.oldLines.length, 0),
  }));
}

/** Build the file diff for a single edit-type tool call (null if not an edit). */
export function buildFileDiff(tc: ToolCallData): FileDiff | null {
  if (toolKind(tc.name) !== "edit") return null;
  const map = new Map<string, FileDiff>();
  collectFromTool(map, tc);
  return finalizeCounts(map)[0] ?? null;
}

/**
 * Aggregate every edit-type tool block across the conversation into a
 * files-changed list (the context rail; no diff REST endpoint exists). Counts
 * are approximate when a tool lacks `old_string`/`new_string`.
 */
export function deriveFilesChanged(items: ConversationItem[]): FileDiff[] {
  const map = new Map<string, FileDiff>();
  for (const item of items) {
    if (item.kind !== "agent") continue;
    for (const block of item.blocks) {
      if (block.type === "tool") collectFromTool(map, block.tool);
    }
  }
  return finalizeCounts(map);
}

/* --------------------------- agents & tasks ----------------------------- */

/**
 * A sub-agent (`Task`) or skill (`Skill`) invocation surfaced from the
 * transcript. ISS-352: the honest "agent task / multiple agents" view — these
 * are the only sub-agent/skill spawns provably present in the stream (no
 * `parentSessionId` column exists yet, so a true session hierarchy is a
 * documented backend follow-up).
 */
export interface AgentTaskInvocation {
  id: string;
  /** Underlying tool: `Task` (sub-agent) or `Skill`. */
  tool: "Task" | "Skill";
  /** Bare descriptor — subagent description/type, or skill name. */
  label: string;
  isError: boolean;
}

/** Bare label for an agent/skill invocation (no "Agent:"/"Skill:" prefix —
 *  the section header already names the category). */
function agentTaskLabel(tc: ToolCallData): string {
  const input = tc.input ?? {};
  if (tc.name === "Skill") return (input.skill as string) ?? "skill";
  return (input.description as string) ?? (input.subagent_type as string) ?? "subtask";
}

/**
 * Collect every `Task`/`Skill` tool block across the conversation (the
 * sub-agent + skill invocations), in transcript order. Frontend-only —
 * `toolKind(name) === 'task'` already classifies these blocks (ISS-352).
 */
export function deriveAgentTasks(items: ConversationItem[]): AgentTaskInvocation[] {
  const out: AgentTaskInvocation[] = [];
  for (const item of items) {
    if (item.kind !== "agent") continue;
    for (const block of item.blocks) {
      if (block.type !== "tool" || toolKind(block.tool.name) !== "task") continue;
      out.push({
        id: block.tool.id,
        tool: block.tool.name === "Skill" ? "Skill" : "Task",
        label: agentTaskLabel(block.tool),
        isError: !!block.tool.isError,
      });
    }
  }
  return out;
}

/**
 * Split a hunk into context/removed/added regions via common prefix+suffix —
 * ported from v1 `inline-diff-summary.tsx`. Pure so it's unit-testable.
 */
export function splitHunk(hunk: DiffHunk): {
  prefix: string[];
  removed: string[];
  added: string[];
  suffix: string[];
} {
  const { oldLines: oldL, newLines: newL } = hunk;
  let start = 0;
  while (start < oldL.length && start < newL.length && oldL[start] === newL[start]) start++;
  let end = 0;
  while (
    end < oldL.length - start &&
    end < newL.length - start &&
    oldL[oldL.length - 1 - end] === newL[newL.length - 1 - end]
  )
    end++;
  return {
    prefix: oldL.slice(0, start),
    removed: oldL.slice(start, oldL.length - end),
    added: newL.slice(start, newL.length - end),
    suffix: oldL.slice(oldL.length - end),
  };
}
