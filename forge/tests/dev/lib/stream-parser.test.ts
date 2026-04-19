import { describe, it, expect } from "vitest";
import { parseStreamMessages } from "@/lib/stream-parser";

describe("parseStreamMessages", () => {
  it("groups text + tool_use into a single assistant message with toolCalls", () => {
    const { messages } = parseStreamMessages({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me read the file." },
          { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "/tmp/test" } },
        ],
      },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("assistant");
    expect(messages[0].content).toBe("Let me read the file.");
    expect(messages[0].toolCalls).toHaveLength(1);
    expect(messages[0].toolCalls![0].name).toBe("read_file");
    expect(messages[0].toolCalls![0].id).toBe("tool-1");
  });

  it("groups multiple tool_use blocks into toolCalls array", () => {
    const { messages } = parseStreamMessages({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
          { type: "tool_use", id: "t2", name: "read_file", input: { path: "b.ts" } },
          { type: "tool_use", id: "t3", name: "glob", input: { pattern: "*.ts" } },
        ],
      },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].toolCalls).toHaveLength(3);
    expect(messages[0].toolCalls![0].name).toBe("read_file");
    expect(messages[0].toolCalls![2].name).toBe("glob");
  });

  it("extracts session ID from system/init", () => {
    const { messages, sessionId } = parseStreamMessages({
      type: "system",
      subtype: "init",
      session_id: "abc-123",
      message: "Session initialized",
    });
    expect(sessionId).toBe("abc-123");
    expect(messages).toHaveLength(1);
    expect(messages[0].subtype).toBe("init");
  });

  it("parses user tool_result messages", () => {
    const { messages } = parseStreamMessages({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "file contents" },
        ],
      },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("tool_result");
    expect(messages[0].toolOutput).toBe("file contents");
    expect(messages[0].toolName).toBe("tool-1");
  });

  it("parses result type with cost", () => {
    const { messages } = parseStreamMessages({
      type: "result",
      result: "Task complete",
      cost_usd: 0.0123,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("system");
    expect(messages[0].subtype).toBe("result");
    expect(messages[0].content).toContain("$0.0123");
  });

  it("returns empty for null input", () => {
    expect(parseStreamMessages(null).messages).toHaveLength(0);
  });

  it("returns empty for input without type", () => {
    expect(parseStreamMessages({ foo: "bar" }).messages).toHaveLength(0);
  });

  it("returns empty for non-array content", () => {
    const { messages } = parseStreamMessages({
      type: "assistant",
      message: { content: "not an array" },
    });
    expect(messages).toHaveLength(0);
  });

  it("returns empty for empty content array", () => {
    const { messages } = parseStreamMessages({
      type: "assistant",
      message: { content: [] },
    });
    expect(messages).toHaveLength(0);
  });

  it("returns empty for unknown type", () => {
    expect(parseStreamMessages({ type: "unknown_type" }).messages).toHaveLength(0);
  });
});
