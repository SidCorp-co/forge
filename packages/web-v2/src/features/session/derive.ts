import { type ConversationItem, type ToolCallData, toolKind } from "./types";

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
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind !== "agent") continue;
    for (const block of item.blocks) {
      if (block.type !== "tool" || toolKind(block.tool.name) !== "task") continue;
      // one tool call is one invocation, however many times a transcript replays its block
      if (seen.has(block.tool.id)) continue;
      seen.add(block.tool.id);
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
