import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock Tauri event listeners
const eventListeners = new Map<string, Function>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: Function) => {
    eventListeners.set(event, cb);
    return vi.fn();
  }),
}));

const mockInvoke = vi.fn();
vi.mock("@/hooks/use-tauri-ipc", () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

const mockUpdateTask = vi.fn().mockResolvedValue({});
vi.mock("@/lib/api", () => ({
  updateTask: (...args: any[]) => mockUpdateTask(...args),
}));

// Mock store with functional state tracking
const storeState = {
  agentMessages: [] as any[],
  agentRunning: false,
  agentSessionId: null as string | null,
  addAgentMessage: vi.fn((msg: any) => {
    storeState.agentMessages.push(msg);
  }),
  clearAgentMessages: vi.fn(() => {
    storeState.agentMessages = [];
  }),
  setAgentRunning: vi.fn((v: boolean) => {
    storeState.agentRunning = v;
  }),
  setAgentSessionId: vi.fn((id: string | null) => {
    storeState.agentSessionId = id;
  }),
};

vi.mock("@/stores/app-store", () => ({
  useAppStore: () => storeState,
}));

import { useAgentStream } from "@/hooks/use-agent-stream";

describe("useAgentStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventListeners.clear();
    storeState.agentMessages = [];
    storeState.agentRunning = false;
    storeState.agentSessionId = null;
    mockInvoke.mockResolvedValue("session-123");
  });

  it("startAgent: stores returned sessionId in state", async () => {
    const { result } = renderHook(() => useAgentStream());

    await act(async () => {
      await result.current.startAgent("/repo", "fix bug", "task-doc-42");
    });

    expect(mockInvoke).toHaveBeenCalledWith("run_agent", {
      repoPath: "/repo",
      prompt: "fix bug",
    });
    expect(storeState.setAgentRunning).toHaveBeenCalledWith(true);
    expect(storeState.setAgentSessionId).toHaveBeenCalledWith("session-123");
    expect(mockUpdateTask).toHaveBeenCalledWith("task-doc-42", { agentStatus: "running" });
  });

  it("startAgent error: sets agentRunning=false and throws", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("invoke fail"));
    const { result } = renderHook(() => useAgentStream());

    let error: Error | undefined;
    try {
      await act(async () => {
        await result.current.startAgent("/repo", "fail");
      });
    } catch (e) {
      error = e as Error;
    }

    expect(error?.message).toBe("invoke fail");
    expect(storeState.setAgentRunning).toHaveBeenCalledWith(false);
  });

  it("abortAgent: starts agent first, then aborts with correct sessionId", async () => {
    const { result } = renderHook(() => useAgentStream());

    await act(async () => {
      await result.current.startAgent("/repo", "do task", "task-doc-10");
    });

    expect(storeState.setAgentSessionId).toHaveBeenCalledWith("session-123");

    storeState.agentSessionId = "session-123";
    mockInvoke.mockResolvedValue(undefined);

    const { result: result2 } = renderHook(() => useAgentStream());

    await act(async () => {
      await result2.current.abortAgent();
    });

    expect(mockInvoke).toHaveBeenCalledWith("abort_agent", {
      sessionId: "session-123",
    });
    expect(storeState.setAgentRunning).toHaveBeenCalledWith(false);
  });

  it("startBatch: builds exact prompt format from tasks", async () => {
    const tasks = [
      { id: 1, documentId: "task-doc-1", title: "Task 1", description: "Do thing 1", acceptanceCriteria: ["criterion a"] },
      { id: 2, documentId: "task-doc-2", title: "Task 2", description: "Do thing 2", acceptanceCriteria: ["criterion b"] },
    ] as any[];

    const { result } = renderHook(() => useAgentStream());

    await act(async () => {
      await result.current.startBatch("/repo", tasks);
    });

    const expectedPrompt =
      "--- Task 1 of 2: Task 1 ---\nDo thing 1\n- [ ] criterion a\n\n--- Task 2 of 2: Task 2 ---\nDo thing 2\n- [ ] criterion b";

    expect(mockInvoke).toHaveBeenCalledWith("run_agent", {
      repoPath: "/repo",
      prompt: expectedPrompt,
    });
    expect(mockUpdateTask).toHaveBeenCalledWith("task-doc-1", { agentStatus: "running" });
    expect(mockUpdateTask).toHaveBeenCalledWith("task-doc-2", { agentStatus: "running" });
  });

  it("message accumulation: parsed message content matches input", async () => {
    renderHook(() => useAgentStream());

    await vi.waitFor(() => expect(eventListeners.has("agent:message")).toBe(true));

    act(() => {
      eventListeners.get("agent:message")!({
        payload: {
          data: {
            type: "assistant",
            message: { content: [{ type: "text", text: "Hello from agent" }] },
          },
        },
      });
    });

    expect(storeState.addAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "assistant",
        content: "Hello from agent",
      }),
    );
    expect(storeState.agentMessages).toHaveLength(1);
    expect(storeState.agentMessages[0].content).toBe("Hello from agent");
  });

  it("completion: agent:complete sets agentRunning=false and updates task status", async () => {
    const { result } = renderHook(() => useAgentStream());

    await act(async () => {
      await result.current.startAgent("/repo", "do work", "task-doc-42");
    });

    await vi.waitFor(() => expect(eventListeners.has("agent:complete")).toBe(true));

    mockUpdateTask.mockClear();
    storeState.setAgentRunning.mockClear();

    act(() => {
      eventListeners.get("agent:complete")!({ payload: {} });
    });

    expect(storeState.setAgentRunning).toHaveBeenCalledWith(false);
    expect(mockUpdateTask).toHaveBeenCalledWith("task-doc-42", {
      agentStatus: "completed",
      status: "done",
    });
  });

  it("completion with error: updates task as failed", async () => {
    const { result } = renderHook(() => useAgentStream());

    await act(async () => {
      await result.current.startAgent("/repo", "do work", "task-doc-42");
    });

    await vi.waitFor(() => expect(eventListeners.has("agent:complete")).toBe(true));

    mockUpdateTask.mockClear();

    act(() => {
      eventListeners.get("agent:complete")!({ payload: { error: "something broke" } });
    });

    expect(storeState.setAgentRunning).toHaveBeenCalledWith(false);
    expect(mockUpdateTask).toHaveBeenCalledWith("task-doc-42", {
      agentStatus: "failed",
      status: undefined,
    });
  });
});
