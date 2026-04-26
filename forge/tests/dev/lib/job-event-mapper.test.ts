import { describe, it, expect } from "vitest";
import { mapStreamChunkToJobEvents } from "@/lib/job-event-mapper";

describe("mapStreamChunkToJobEvents", () => {
  it("maps assistant text content to stdout events", () => {
    const events = mapStreamChunkToJobEvents({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    expect(events).toEqual([{ kind: "stdout", data: { text: "hello" } }]);
  });

  it("maps assistant tool_use to tool_call with id+name+input", () => {
    const events = mapStreamChunkToJobEvents({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "x" } },
        ],
      },
    });
    expect(events).toEqual([
      { kind: "tool_call", data: { id: "tu-1", name: "Read", input: { file_path: "x" } } },
    ]);
  });

  it("maps user tool_result blocks to tool_result events; stderr when is_error", () => {
    const events = mapStreamChunkToJobEvents({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu-1", content: "ok" },
          { type: "tool_result", tool_use_id: "tu-2", content: "boom", is_error: true },
        ],
      },
    });
    expect(events).toEqual([
      { kind: "tool_result", data: { tool_use_id: "tu-1", content: "ok", is_error: false } },
      { kind: "stderr", data: { tool_use_id: "tu-2", content: "boom", is_error: true } },
    ]);
  });

  it("maps result chunks to a single result event", () => {
    const chunk = { type: "result", cost_usd: 0.0123 };
    expect(mapStreamChunkToJobEvents(chunk)).toEqual([{ kind: "result", data: chunk }]);
  });

  it("maps system + unknown chunks to progress events", () => {
    const sys = { type: "system", subtype: "init", session_id: "s-1" };
    const unknown = { type: "weird", foo: 1 };
    expect(mapStreamChunkToJobEvents(sys)).toEqual([{ kind: "progress", data: sys }]);
    expect(mapStreamChunkToJobEvents(unknown)).toEqual([{ kind: "progress", data: unknown }]);
  });

  it("returns [] for empty / non-object input", () => {
    expect(mapStreamChunkToJobEvents(null)).toEqual([]);
    expect(mapStreamChunkToJobEvents("string")).toEqual([]);
  });
});
