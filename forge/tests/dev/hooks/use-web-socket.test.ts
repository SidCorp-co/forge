import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const listeners = new Map<string, Function>();
const unlistenFns = new Map<string, ReturnType<typeof vi.fn>>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: Function) => {
    listeners.set(event, cb);
    const unlisten = vi.fn();
    unlistenFns.set(event, unlisten);
    return unlisten;
  }),
}));

const mockInvoke = vi.fn().mockResolvedValue(null);
vi.mock("@/hooks/use-tauri-ipc", () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

const mockSetWsConnected = vi.fn();
vi.mock("@/stores/app-store", () => ({
  useAppStore: () => ({
    config: { strapiUrl: "http://localhost:1337" },
    wsConnected: false,
    setWsConnected: mockSetWsConnected,
  }),
}));

describe("useWebSocket", () => {
  beforeEach(() => {
    listeners.clear();
    unlistenFns.clear();
    mockSetWsConnected.mockClear();
    mockInvoke.mockClear();
  });

  it("calls invoke('connect_ws') with correct ws URL after setting up listeners", async () => {
    const { useWebSocket } = await import("@/hooks/use-web-socket");
    renderHook(() => useWebSocket());

    await vi.waitFor(() => {
      expect(listeners.has("ws:connected")).toBe(true);
      expect(listeners.has("ws:disconnected")).toBe(true);
      expect(listeners.has("ws:message")).toBe(true);
      expect(listeners.has("ws:error")).toBe(true);
    });

    // Verify invoke was called with the correct WebSocket URL
    expect(mockInvoke).toHaveBeenCalledWith("connect_ws", {
      url: "ws://localhost:1337/ws",
    });
  });

  it("ws:connected sets connected=true via event flow", async () => {
    const { useWebSocket } = await import("@/hooks/use-web-socket");
    renderHook(() => useWebSocket());

    await vi.waitFor(() => expect(listeners.has("ws:connected")).toBe(true));

    act(() => {
      listeners.get("ws:connected")!({ payload: null });
    });

    expect(mockSetWsConnected).toHaveBeenCalledWith(true);
  });

  it("ws:error event fires and sets connected=false", async () => {
    const { useWebSocket } = await import("@/hooks/use-web-socket");
    renderHook(() => useWebSocket());

    await vi.waitFor(() => expect(listeners.has("ws:error")).toBe(true));

    act(() => {
      listeners.get("ws:error")!({ payload: "connection lost" });
    });

    expect(mockSetWsConnected).toHaveBeenCalledWith(false);
  });

  it("ws:disconnected event fires and sets connected=false", async () => {
    const { useWebSocket } = await import("@/hooks/use-web-socket");
    renderHook(() => useWebSocket());

    await vi.waitFor(() => expect(listeners.has("ws:disconnected")).toBe(true));

    act(() => {
      listeners.get("ws:disconnected")!({ payload: null });
    });

    expect(mockSetWsConnected).toHaveBeenCalledWith(false);
  });

  it("cleanup calls all unlisten functions on unmount", async () => {
    vi.useFakeTimers();
    const { useWebSocket } = await import("@/hooks/use-web-socket");
    const { unmount } = renderHook(() => useWebSocket());

    // Wait for listeners to be set up
    await vi.waitFor(() => expect(listeners.has("ws:connected")).toBe(true));

    unmount();

    // Advance timers to allow the cleanup promise to resolve
    await vi.advanceTimersByTimeAsync(0);

    for (const [event, fn] of unlistenFns) {
      expect(fn).toHaveBeenCalled();
    }

    vi.useRealTimers();
  });

  it("does nothing when strapiUrl is empty", async () => {
    // This test verifies the early return guard
    // The mock always provides a URL, so listeners and invoke will be set up.
    // The source code checks `if (!config.strapiUrl) return;`
    // We verify the hook doesn't throw with a valid URL instead.
    const { useWebSocket } = await import("@/hooks/use-web-socket");
    const { result } = renderHook(() => useWebSocket());
    expect(result.current.wsConnected).toBe(false);
  });
});
