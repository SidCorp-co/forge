import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/hooks/use-tauri-ipc", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

import { SessionTracker } from "@/lib/session-tracker";

describe("SessionTracker", () => {
  let tracker: SessionTracker;

  beforeEach(() => {
    tracker = new SessionTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
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

describe("SessionTracker — incremental remote persist (ISS-84)", () => {
  it("flushes after 5 messages without waiting for the timer", async () => {
    vi.useFakeTimers();
    const remotePersist = vi.fn().mockResolvedValue(undefined);
    const t = new SessionTracker({ remotePersist });

    t.start("local-1", "slug", "prompt", { agentSessionId: "as-1" });
    for (let i = 0; i < 5; i++) {
      t.addUserMessage("local-1", `msg-${i}`);
    }
    await Promise.resolve();

    expect(remotePersist).toHaveBeenCalledTimes(1);
    const [agentSessionId, snap] = remotePersist.mock.calls[0]!;
    expect(agentSessionId).toBe("as-1");
    expect(snap.messages).toHaveLength(6);
    expect(snap.claudeSessionId).toBeNull();
  });

  it("flushes after 30s when threshold not reached", async () => {
    vi.useFakeTimers();
    const remotePersist = vi.fn().mockResolvedValue(undefined);
    const t = new SessionTracker({ remotePersist });

    t.start("local-2", "slug", "prompt", { agentSessionId: "as-2" });
    t.addUserMessage("local-2", "one more");

    expect(remotePersist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(remotePersist).toHaveBeenCalledTimes(1);
  });

  it("coalesces back-to-back chunks under threshold into one timed flush", async () => {
    vi.useFakeTimers();
    const remotePersist = vi.fn().mockResolvedValue(undefined);
    const t = new SessionTracker({ remotePersist });

    t.start("local-3", "slug", "prompt", { agentSessionId: "as-3" });
    t.addUserMessage("local-3", "a");
    await vi.advanceTimersByTimeAsync(500);
    t.addUserMessage("local-3", "b");
    await vi.advanceTimersByTimeAsync(500);
    t.addUserMessage("local-3", "c");

    expect(remotePersist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(remotePersist).toHaveBeenCalledTimes(1);
  });

  it("skips remote flush when agentSessionId is not configured", async () => {
    vi.useFakeTimers();
    const remotePersist = vi.fn().mockResolvedValue(undefined);
    const t = new SessionTracker({ remotePersist });

    t.start("local-4", "slug", "prompt"); // no agentSessionId
    for (let i = 0; i < 10; i++) {
      t.addUserMessage("local-4", `msg-${i}`);
    }
    await vi.advanceTimersByTimeAsync(30_000);

    expect(remotePersist).not.toHaveBeenCalled();
  });

  it("complete() does not fire an incremental remote PATCH", async () => {
    vi.useFakeTimers();
    const remotePersist = vi.fn().mockResolvedValue(undefined);
    const t = new SessionTracker({ remotePersist });

    t.start("local-5", "slug", "prompt", { agentSessionId: "as-5" });
    t.addUserMessage("local-5", "one");
    t.complete("local-5");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(remotePersist).not.toHaveBeenCalled();
  });

  it("flushAll() drains pending sessions and clears timers", async () => {
    vi.useFakeTimers();
    const remotePersist = vi.fn().mockResolvedValue(undefined);
    const t = new SessionTracker({ remotePersist });

    t.start("local-6a", "slug", "prompt-a", { agentSessionId: "as-6a" });
    t.addUserMessage("local-6a", "a");

    t.start("local-6b", "slug", "prompt-b", { agentSessionId: "as-6b" });
    t.addUserMessage("local-6b", "b");

    await t.flushAll();

    expect(remotePersist).toHaveBeenCalledTimes(2);
    const ids = remotePersist.mock.calls.map((c) => c[0]).sort();
    expect(ids).toEqual(["as-6a", "as-6b"]);
  });

  it("incremental PATCH failure does not throw out of stream activity", async () => {
    vi.useFakeTimers();
    const remotePersist = vi.fn().mockRejectedValue(new Error("net down"));
    const t = new SessionTracker({ remotePersist });

    t.start("local-7", "slug", "prompt", { agentSessionId: "as-7" });
    expect(() => {
      for (let i = 0; i < 6; i++) {
        t.addUserMessage("local-7", `msg-${i}`);
      }
    }).not.toThrow();

    // Let the rejected promise settle inside the catch handler
    await vi.advanceTimersByTimeAsync(0);

    expect(remotePersist).toHaveBeenCalledTimes(1);

    // Subsequent activity should still arm a fresh timer + flush
    for (let i = 0; i < 5; i++) {
      t.addUserMessage("local-7", `next-${i}`);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(remotePersist).toHaveBeenCalledTimes(2);
  });
});
