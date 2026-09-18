import { describe, expect, it } from "vitest";
import {
  buildFileDiff,
  deriveAgentTasks,
  deriveFilesChanged,
  getToolLabel,
  parseMessages,
  parseTurns,
  splitHunk,
  toolKind,
  type TurnRow,
} from "./types";

function turn(over: Partial<TurnRow> & { id: string; turnIndex: number; role: TurnRow["role"] }): TurnRow {
  return {
    id: over.id,
    agentSessionId: over.agentSessionId ?? "sess",
    turnIndex: over.turnIndex,
    role: over.role,
    content: over.content ?? null,
    editedAt: over.editedAt ?? null,
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("parseTurns", () => {
  it("maps a user turn to an editable prompt item", () => {
    const items = parseTurns([
      turn({ id: "t0", turnIndex: 0, role: "user", content: { value: { type: "user", content: "fix the bug" } } }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "prompt", text: "fix the bug", turnId: "t0" });
  });

  it("parses an assistant turn with text + tool_use + diff", () => {
    const items = parseTurns([
      turn({
        id: "t1",
        turnIndex: 1,
        role: "assistant",
        content: {
          value: {
            type: "assistant",
            blocks: [
              { type: "text", text: "Editing now" },
              {
                type: "tool",
                toolCall: {
                  id: "tc1",
                  name: "Edit",
                  input: { file_path: "a.ts", old_string: "x", new_string: "y" },
                },
              },
            ],
          },
        },
      }),
    ]);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.kind).toBe("agent");
    expect(item.blocks[0]).toEqual({ type: "text", text: "Editing now" });
    expect(item.blocks[1].type).toBe("tool");
  });

  it("converts TodoWrite tool calls into a deduped todos block", () => {
    const items = parseTurns([
      turn({
        id: "t2",
        turnIndex: 2,
        role: "assistant",
        content: {
          value: {
            type: "assistant",
            blocks: [
              { type: "tool", toolCall: { id: "a", name: "TodoWrite", input: { todos: [{ content: "one", status: "pending" }] } } },
              { type: "tool", toolCall: { id: "b", name: "TodoWrite", input: { todos: [{ content: "two", status: "completed" }] } } },
            ],
          },
        },
      }),
    ]);
    const todos = items[0].blocks.filter((b) => b.type === "todos");
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({ type: "todos", todos: [{ content: "two", status: "completed" }] });
  });

  it("derives blocks from bare toolCalls + content when a turn carries no ordered blocks", () => {
    const items = parseTurns([
      turn({
        id: "t3",
        turnIndex: 3,
        role: "assistant",
        content: {
          value: {
            type: "assistant",
            content: "done",
            toolCalls: [{ id: "r", name: "Read", input: { file_path: "b.ts" } }],
          },
        },
      }),
    ]);
    expect(items[0].blocks.map((b) => b.type)).toEqual(["tool", "text"]);
  });

  it("unwraps a flat entry (no { value } wrapper) and drops empty turns", () => {
    const items = parseTurns([
      turn({ id: "flat", turnIndex: 0, role: "user", content: { type: "user", content: "hi" } as never }),
      turn({ id: "empty", turnIndex: 1, role: "assistant", content: { value: { type: "assistant" } } }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("hi");
  });
});

describe("parseMessages (canonical CLI-runner shape)", () => {
  it("renders interleaved text + tool blocks in original order (text not dropped)", () => {
    const items = parseMessages([
      { type: "user", content: "fix the bug" },
      {
        id: "m1",
        type: "assistant",
        content: "Looking now then editing",
        blocks: [
          { type: "text", text: "Looking now" },
          { type: "tool", toolCall: { id: "tc1", name: "Read", input: { file_path: "a.ts" }, output: "ok" } },
          { type: "text", text: "then editing" },
          { type: "tool", toolCall: { id: "tc2", name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } } },
        ],
      },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "prompt", text: "fix the bug" });
    const agent = items[1];
    expect(agent.kind).toBe("agent");
    expect(agent.blocks.map((b) => b.type)).toEqual(["text", "tool", "text", "tool"]);
    expect(agent.blocks[0]).toEqual({ type: "text", text: "Looking now" });
    expect(agent.blocks[2]).toEqual({ type: "text", text: "then editing" });
  });

  it("normalizes the canonical toolCall output onto result", () => {
    const items = parseMessages([
      {
        type: "assistant",
        blocks: [{ type: "tool", toolCall: { id: "t", name: "Bash", input: { command: "ls" }, output: "file.ts" } }],
      },
    ]);
    const block = items[0].blocks[0];
    expect(block.type).toBe("tool");
    if (block.type === "tool") expect(block.tool.result).toBe("file.ts");
  });

  it("converts canonical TodoWrite tool blocks and dedupes todos", () => {
    const items = parseMessages([
      {
        type: "assistant",
        blocks: [
          { type: "todos", todos: [{ content: "one", status: "pending" }] },
          { type: "todos", todos: [{ content: "two", status: "completed" }] },
        ],
      },
    ]);
    const todos = items[0].blocks.filter((b) => b.type === "todos");
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({ todos: [{ content: "two", status: "completed" }] });
  });

  it("drops empty / merged-away entries and assigns synthetic ids", () => {
    const items = parseMessages([
      { type: "system", content: "" },
      { type: "tool_result", toolName: "tc1", toolOutput: "x" },
      { type: "assistant", content: "real", blocks: [{ type: "text", text: "real" }] },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("msg-2");
    expect(items[0].turnId).toBe("");
  });
});

// cm:guard the thinking block and the bare count are ONE render member with three shapes behind it,
// and these cases are what keep them one: the assistant providers send readable reasoning as a
// block, they send an encrypted pause as a block with no text at all, and the Claude Code derive
// sends a number and no block. A reader is shown the same line by all three (ISS-1079).
describe("parseMessages — thinking", () => {
  it("maps a canonical thinking block, keeping its text, its duration and its place", () => {
    const [item] = parseMessages([
      {
        type: "assistant",
        content: "Two left.",
        blocks: [
          { type: "thinking", thinking: "let me check the list", durationMs: 420 },
          { type: "text", text: "Two left." },
        ],
      },
    ]);
    expect(item.blocks.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(item.blocks[0]).toEqual({ type: "thinking", text: "let me check the list", durationMs: 420 });
  });

  it("keeps a thinking block between the prose and the tool it sat between", () => {
    const [item] = parseMessages([
      {
        type: "assistant",
        blocks: [
          { type: "text", text: "Let me look." },
          { type: "thinking", thinking: "which list?" },
          { type: "tool", toolCall: { id: "t1", name: "Read", input: {} } },
          { type: "text", text: "Two left." },
        ],
      },
    ]);
    expect(item.blocks.map((b) => b.type)).toEqual(["text", "thinking", "tool", "text"]);
  });

  // cm:why the count is PREPENDED: a count has no position — it is a property of the turn and not a
  // block in its order — and the pause it records came before the output in every case either
  // producer can emit. Saying so here rather than leaving the choice to be read off the code.
  it("turns a bare thinkingCount into the same block, with no text to expand", () => {
    const [item] = parseMessages([
      { type: "assistant", content: "done", thinkingCount: 3, blocks: [{ type: "text", text: "done" }] },
    ]);
    expect(item.blocks.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(item.blocks[0]).toEqual({ type: "thinking", count: 3 });
  });

  it("reports a readable pause and an encrypted one on the same turn", () => {
    const [item] = parseMessages([
      {
        type: "assistant",
        thinkingCount: 1,
        blocks: [
          { type: "thinking", thinking: "readable" },
          { type: "text", text: "done" },
        ],
      },
    ]);
    expect(item.blocks.map((b) => b.type)).toEqual(["thinking", "thinking", "text"]);
    expect(item.blocks[0]).toEqual({ type: "thinking", count: 1 });
    expect(item.blocks[1]).toMatchObject({ text: "readable" });
  });

  // cm:guard a turn whose only content was a pause is DROPPED today — `parseMessages` skips an entry
  // whose blocks come back empty, and a count was never a block. Every Claude Code turn that thought
  // and then called nothing was invisible (ISS-1079 criterion 17).
  it("renders a turn that holds nothing but a pause", () => {
    const items = parseMessages([{ type: "assistant", thinkingCount: 2 }]);
    expect(items).toHaveLength(1);
    expect(items[0]?.blocks).toEqual([{ type: "thinking", count: 2 }]);
  });

  it("maps an encrypted pause to a block with no text and no count", () => {
    const [item] = parseMessages([
      {
        type: "assistant",
        blocks: [{ type: "thinking" }, { type: "text", text: "ok" }],
      },
    ]);
    expect(item.blocks[0]).toEqual({ type: "thinking" });
  });

  // cm:guard two encrypted pauses are two lines, not one line saying twice: each redacted event
  // appends its own block, and the order of the blocks is the record of what the turn did. Noted as
  // untested by the whole-set read, so it is tested.
  it("keeps two encrypted pauses as two separate lines", () => {
    const [item] = parseMessages([
      {
        type: "assistant",
        blocks: [
          { type: "thinking" },
          { type: "text", text: "half" },
          { type: "thinking" },
          { type: "text", text: "and half" },
        ],
      },
    ]);
    expect(item.blocks.map((b) => b.type)).toEqual(["thinking", "text", "thinking", "text"]);
  });

  it("renders no thinking block for a turn that paused not at all", () => {
    const [item] = parseMessages([
      { type: "assistant", content: "done", blocks: [{ type: "text", text: "done" }] },
    ]);
    expect(item.blocks.map((b) => b.type)).toEqual(["text"]);
  });
});

describe("file diffs", () => {
  it("buildFileDiff counts added/removed lines for an Edit", () => {
    const diff = buildFileDiff({ id: "x", name: "Edit", input: { file_path: "f.ts", old_string: "a\nb", new_string: "a\nc\nd" } });
    expect(diff).not.toBeNull();
    expect(diff?.path).toBe("f.ts");
    expect(diff?.added).toBe(3);
    expect(diff?.removed).toBe(2);
  });

  it("buildFileDiff treats Write as a new file", () => {
    const diff = buildFileDiff({ id: "x", name: "Write", input: { file_path: "n.ts", content: "l1\nl2" } });
    expect(diff?.isNew).toBe(true);
    expect(diff?.added).toBe(2);
  });

  it("buildFileDiff aggregates MultiEdit edits", () => {
    const diff = buildFileDiff({
      id: "x",
      name: "MultiEdit",
      input: { file_path: "m.ts", edits: [{ old_string: "1", new_string: "2" }, { old_string: "3", new_string: "4" }] },
    });
    expect(diff?.hunks).toHaveLength(2);
  });

  it("returns null for non-edit tools", () => {
    expect(buildFileDiff({ id: "x", name: "Read", input: { file_path: "r.ts" } })).toBeNull();
  });

  it("deriveFilesChanged aggregates edits across turns per path", () => {
    const items = parseTurns([
      turn({
        id: "t1",
        turnIndex: 0,
        role: "assistant",
        content: {
          value: {
            type: "assistant",
            blocks: [
              { type: "tool", toolCall: { id: "a", name: "Edit", input: { file_path: "same.ts", old_string: "x", new_string: "y" } } },
              { type: "tool", toolCall: { id: "b", name: "Edit", input: { file_path: "same.ts", old_string: "p", new_string: "q" } } },
            ],
          },
        },
      }),
    ]);
    const files = deriveFilesChanged(items);
    expect(files).toHaveLength(1);
    expect(files[0].hunks).toHaveLength(2);
  });
});

describe("deriveAgentTasks", () => {
  it("lists Task (sub-agent) and Skill invocations from the transcript, in order", () => {
    const items = parseMessages([
      {
        type: "assistant",
        blocks: [
          { type: "tool", toolCall: { id: "a", name: "Task", input: { description: "Explore repo", subagent_type: "Explore" } } },
          { type: "tool", toolCall: { id: "b", name: "Read", input: { file_path: "x.ts" } } },
          { type: "tool", toolCall: { id: "c", name: "Skill", input: { skill: "forge-code" } } },
          { type: "tool", toolCall: { id: "d", name: "Task", input: { subagent_type: "general-purpose" }, isError: true } },
        ],
      },
    ]);
    const tasks = deriveAgentTasks(items);
    expect(tasks).toEqual([
      { id: "a", tool: "Task", label: "Explore repo", isError: false },
      { id: "c", tool: "Skill", label: "forge-code", isError: false },
      { id: "d", tool: "Task", label: "general-purpose", isError: true },
    ]);
  });

  it("returns an empty list when no Task/Skill blocks are present", () => {
    const items = parseMessages([
      { type: "assistant", blocks: [{ type: "tool", toolCall: { id: "r", name: "Read", input: { file_path: "a.ts" } } }] },
    ]);
    expect(deriveAgentTasks(items)).toEqual([]);
  });
});

describe("splitHunk", () => {
  it("isolates the changed region via common prefix/suffix", () => {
    const r = splitHunk({ oldLines: ["a", "b", "c"], newLines: ["a", "x", "c"] });
    expect(r.prefix).toEqual(["a"]);
    expect(r.removed).toEqual(["b"]);
    expect(r.added).toEqual(["x"]);
    expect(r.suffix).toEqual(["c"]);
  });
});

describe("tool labels + kinds", () => {
  it("labels common tools", () => {
    expect(getToolLabel({ id: "1", name: "Edit", input: { file_path: "a.ts" } })).toBe("Updated a.ts");
    expect(getToolLabel({ id: "2", name: "Read", input: { file_path: "b.ts" } })).toBe("Read b.ts");
    expect(getToolLabel({ id: "3", name: "mcp__forge__forge_issues", input: { action: "update", documentId: "abcd1234efgh" } })).toContain("Issue");
  });
  it("classifies tool kinds", () => {
    expect(toolKind("Write")).toBe("edit");
    expect(toolKind("Grep")).toBe("search");
    expect(toolKind("Bash")).toBe("run");
    expect(toolKind("Read")).toBe("read");
    expect(toolKind("SomethingElse")).toBe("generic");
  });
});

/**
 * ISS-1029 — the Forge assistant path now persists the SAME canonical entry the
 * Claude Code CLI path does, so this formatter renders both. These cases are
 * written against what `packages/core/src/conversations/store.ts
 * toCanonicalEntry` returns for an assistant `conversation_messages` row, and
 * they exist to fail if that shape and this reader ever drift apart.
 */
// cm:guard nothing in `types.ts` was changed to make these pass, and nothing may be: the whole
// point of the issue is that the assistant path was made to fit the reader that already existed.
describe("parseMessages over an assistant conversation row", () => {
  /** What `toCanonicalEntry` returns for a turn that wrote prose, called a failing tool, wrote more. */
  const assistantEntry = {
    id: "row-7",
    type: "assistant" as const,
    timestamp: 1_700_000_000_000,
    content: "That failed.",
    blocks: [
      { type: "text" as const, text: "Let me look." },
      {
        type: "tool" as const,
        toolCall: {
          id: "c1",
          name: "forge_issues",
          input: { action: "list" },
          output: "boom",
          isError: true,
          durationMs: 12,
        },
      },
      { type: "text" as const, text: "That failed." },
    ],
    toolCalls: [
      {
        id: "c1",
        name: "forge_issues",
        input: { action: "list" },
        output: "boom",
        isError: true,
        durationMs: 12,
      },
    ],
  };

  it("renders the prose, the tool and the prose after it, in that order", () => {
    const items = parseMessages([assistantEntry]);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("agent");
    expect(items[0]?.blocks.map((b) => b.type)).toEqual(["text", "tool", "text"]);
  });

  it("carries the tool's name, output and error state into the render block", () => {
    const [item] = parseMessages([assistantEntry]);
    const block = item?.blocks[1];
    expect(block?.type).toBe("tool");
    if (block?.type !== "tool") throw new Error("expected a tool block");
    expect(block.tool.name).toBe("forge_issues");
    // cm:guard `result ?? output` is the field-drift normalisation this formatter already carried;
    // the assistant path writes `output`, like the CLI derive does, so it needs no new branch.
    expect(block.tool.result).toBe("boom");
    expect(block.tool.isError).toBe(true);
    expect(block.tool.durationMs).toBe(12);
  });

  it("labels the tool the same way it labels one from a CLI session", () => {
    const [item] = parseMessages([assistantEntry]);
    const block = item?.blocks[1];
    if (block?.type !== "tool") throw new Error("expected a tool block");
    // A bare tool name falls to the default branch and labels as itself; the `mcp__` prefix is what
    // routes a name through `formatMcpLabel`, and the assistant path's tools arrive either way.
    expect(getToolLabel(block.tool)).toBe("forge_issues");
    expect(
      getToolLabel({ id: "c2", name: "mcp__forge__forge_issues", input: { action: "list" } }),
    ).toBe("Issues(list)");
  });

  it("renders a legacy row, whose whole answer is its text, as one text block", () => {
    // What `toCanonicalEntry` returns for a row written before the blocks column existed.
    const items = parseMessages([
      {
        id: "row-1",
        type: "assistant",
        timestamp: 1_700_000_000_000,
        content: "You have two.",
        blocks: [{ type: "text", text: "You have two." }],
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.blocks).toEqual([{ type: "text", text: "You have two." }]);
  });

  it("renders the user side of the same conversation as an editable prompt", () => {
    const items = parseMessages([
      { id: "row-0", type: "user", timestamp: 1, content: "how many open issues?" },
      assistantEntry,
    ]);
    expect(items.map((i) => i.kind)).toEqual(["prompt", "agent"]);
    expect(items[0]?.text).toBe("how many open issues?");
  });
});

// cm:guard the two v1 paths reach a card through `toToolCallData` like the canonical one does. They
// used to hand their calls through untouched, which was invisible while the card only previewed
// `result` — a CLI-derived entry carries its output on `output`, so `result` was undefined and the
// card drew nothing. Since ISS-1083 an absent result reads `Running…`, and a settled turn in
// history claiming a call is still out is worse than drawing nothing.
describe("every tool call is decoded, whichever shape the entry is in", () => {
  it("decodes a v1 toolCalls entry's output instead of leaving it unread", () => {
    const [item] = parseMessages([
      {
        type: "assistant",
        content: "done",
        toolCalls: [
          { id: "t1", name: "Read", input: {}, output: '{"a":1,"b":2}' },
        ],
      } as never,
    ]);
    const block = item?.blocks.find((b) => b.type === "tool");
    expect(block).toBeDefined();
    if (block?.type !== "tool") throw new Error("expected a tool block");
    expect(block.tool.result).toEqual({ a: 1, b: 2 });
  });

  it("decodes an ordered block's tool output too", () => {
    const [item] = parseMessages([
      {
        type: "assistant",
        content: "done",
        blocks: [
          { type: "tool", toolCall: { id: "t2", name: "Read", input: {}, output: "[]" } },
        ],
      } as never,
    ]);
    const block = item?.blocks.find((b) => b.type === "tool");
    if (block?.type !== "tool") throw new Error("expected a tool block");
    expect(block.tool.result).toEqual([]);
  });

  it("leaves a v1 call's own `result` exactly as it stands", () => {
    const [item] = parseMessages([
      {
        type: "assistant",
        content: "done",
        toolCalls: [{ id: "t3", name: "Read", input: {}, result: "plain words" }],
      } as never,
    ]);
    const block = item?.blocks.find((b) => b.type === "tool");
    if (block?.type !== "tool") throw new Error("expected a tool block");
    expect(block.tool.result).toBe("plain words");
  });
});
