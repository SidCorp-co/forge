import { describe, expect, it } from "vitest";
import {
  buildFileDiff,
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
      turn({ id: "t0", turnIndex: 0, role: "user", content: { value: { role: "user", content: "fix the bug" } } }),
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
            role: "assistant",
            contentBlocks: [
              { type: "text", text: "Editing now" },
              {
                type: "tool_use",
                tool: {
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
            role: "assistant",
            contentBlocks: [
              { type: "tool_use", tool: { id: "a", name: "TodoWrite", input: { todos: [{ content: "one", status: "pending" }] } } },
              { type: "tool_use", tool: { id: "b", name: "TodoWrite", input: { todos: [{ content: "two", status: "completed" }] } } },
            ],
          },
        },
      }),
    ]);
    const todos = items[0].blocks.filter((b) => b.type === "todos");
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({ type: "todos", todos: [{ content: "two", status: "completed" }] });
  });

  it("derives blocks from legacy toolCalls + content when contentBlocks absent", () => {
    const items = parseTurns([
      turn({
        id: "t3",
        turnIndex: 3,
        role: "assistant",
        content: {
          value: {
            role: "assistant",
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
      turn({ id: "flat", turnIndex: 0, role: "user", content: { role: "user", content: "hi" } as never }),
      turn({ id: "empty", turnIndex: 1, role: "assistant", content: { value: { role: "assistant" } } }),
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
            role: "assistant",
            contentBlocks: [
              { type: "tool_use", tool: { id: "a", name: "Edit", input: { file_path: "same.ts", old_string: "x", new_string: "y" } } },
              { type: "tool_use", tool: { id: "b", name: "Edit", input: { file_path: "same.ts", old_string: "p", new_string: "q" } } },
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
