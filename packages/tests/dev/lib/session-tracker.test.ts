import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/hooks/use-tauri-ipc", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

import { SessionTracker } from "@/lib/session-tracker";

describe("SessionTracker", () => {
  let tracker: SessionTracker;

  beforeEach(() => {
    tracker = new SessionTracker();
  });

  it("preserves history across turns (ISS-83 regression)", () => {
    tracker.start("sess-1", "slug", "prompt 1");
    tracker.handleStreamData("sess-1", {
      type: "assistant",
      message: { content: [{ type: "text", text: "reply 1" }] },
    });
    tracker.complete("sess-1");

    tracker.addUserMessage("sess-1", "prompt 2");
    tracker.handleStreamData("sess-1", {
      type: "assistant",
      message: { content: [{ type: "text", text: "reply 2" }] },
    });
    tracker.complete("sess-1");

    const snap = tracker.getSnapshot("sess-1");
    expect(snap).toBeDefined();
    expect(snap!.messages).toHaveLength(4);

    expect(snap!.messages[0].type).toBe("user");
    expect(snap!.messages[0].content).toBe("prompt 1");
    expect(snap!.messages[1].type).toBe("assistant");
    expect(snap!.messages[1].content).toContain("reply 1");
    expect(snap!.messages[2].type).toBe("user");
    expect(snap!.messages[2].content).toBe("prompt 2");
    expect(snap!.messages[3].type).toBe("assistant");
    expect(snap!.messages[3].content).toContain("reply 2");
  });

  it("returns a snapshot after a single-turn complete()", () => {
    tracker.start("sess-2", "slug", "hello");
    tracker.handleStreamData("sess-2", {
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    tracker.complete("sess-2");

    const snap = tracker.getSnapshot("sess-2");
    expect(snap).toBeDefined();
    expect(snap!.messages).toHaveLength(2);
    expect(snap!.messages[0].content).toBe("hello");
    expect(snap!.messages[1].content).toContain("hi");
  });

  it("dispose() clears tracking", () => {
    tracker.start("sess-3", "slug", "hello");
    tracker.complete("sess-3");
    expect(tracker.getSnapshot("sess-3")).toBeDefined();

    tracker.dispose();
    expect(tracker.getSnapshot("sess-3")).toBeUndefined();
  });

  it("retains claudeSessionId derived from a system/init stream", () => {
    tracker.start("sess-4", "slug", "hello");
    tracker.handleStreamData("sess-4", {
      type: "system",
      subtype: "init",
      session_id: "claude-abc-123",
      message: "Session initialized",
    });
    tracker.complete("sess-4");

    const snap = tracker.getSnapshot("sess-4");
    expect(snap?.claudeSessionId).toBe("claude-abc-123");
  });
});
