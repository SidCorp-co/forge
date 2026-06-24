import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Force the Tauri event listener to throw so useWebSocket falls through to
// the browser-fallback path (`new WebSocket(...)`). The Rust adapter is a
// thin glue over `ws_send`; covering the browser path here exercises the
// same `registerAllRunners` / `subscribeToProjectRooms` multi-project loop.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.reject(new Error("not in tauri"))),
}));

const mockInvoke = vi.fn((cmd: string) => {
  if (cmd === "get_hostname") return Promise.resolve("TestHost");
  // Everything else (get_skill_hashes, load_device_token, etc.) rejects so
  // the hook treats the host as a non-Tauri context.
  return Promise.reject(new Error("tauri unavailable"));
});
vi.mock("@/hooks/use-tauri-ipc", () => ({
  invoke: (...args: any[]) => mockInvoke(...(args as [any])),
}));

vi.mock("@/lib/api", () => ({
  relayAgentEvent: vi.fn(),
  patchAgentSession: vi.fn(),
  getProject: vi.fn(),
  getAgents: vi.fn(),
  syncAgentFiles: vi.fn(),
  postJobEvents: vi.fn(),
  completeJob: vi.fn(),
}));

vi.mock("@/lib/skill-sync", () => ({
  syncAllProjectSkills: vi.fn().mockResolvedValue(false),
  syncProjectSkills: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/hooks/use-agent-commands", () => ({
  useAgentCommandHandler: () => ({ current: vi.fn() }),
}));

vi.mock("@/hooks/use-job-handler", () => ({
  useJobAssignedHandler: () => ({
    handlerRef: { current: vi.fn() },
    jobSessionsRef: { current: new Set<string>() },
    cancelledJobsRef: { current: new Set<string>() },
    jobAgentSessionsRef: { current: new Map<string, string>() },
  }),
}));

const setRunnerBinding = vi.fn();
const clearRunnerBindings = vi.fn();
const setWsConnected = vi.fn();
const setDeviceSettings = vi.fn();

vi.mock("@/stores/app-store", () => {
  const state = {
    wsConnected: false,
    setWsConnected,
    setDeviceSettings,
    deviceSettings: {
      projects: {
        "proj-a": { slug: "proj-a", documentId: "doc-a" },
        "proj-b": { slug: "proj-b", documentId: "doc-b" },
        // Negative case: no documentId — must NOT emit a runner:register frame.
        "proj-c": { slug: "proj-c" },
      },
    },
    runnerBindings: {} as Record<string, { runnerId: string; status: string }>,
    setRunnerBinding,
    clearRunnerBindings,
  };
  const useAppStore: any = (sel?: (s: any) => any) => (sel ? sel(state) : state);
  useAppStore.getState = () => state;
  return { useAppStore };
});

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    phase: "authenticated",
    coreUrl: "http://localhost:8080",
    deviceId: "dev-1",
    token: "jwt-token",
  }),
}));

// In-memory WebSocket mock. jsdom ships one but we need to inspect sent
// frames and trigger `onopen` deterministically.
class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState: number = MockWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  constructor(public url: string, public protocols?: string | string[]) {
    MockWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
  triggerOpen() {
    this.onopen?.();
  }
}

let originalWebSocket: any;

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client }, children);
}

describe("useWebSocket — browser fallback runner registration", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    setRunnerBinding.mockClear();
    clearRunnerBindings.mockClear();
    setWsConnected.mockClear();
    setDeviceSettings.mockClear();
    mockInvoke.mockClear();
    originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    (globalThis as any).WebSocket = originalWebSocket;
  });

  async function flushMicrotasks() {
    // Two ticks: registerAllRunners awaits invoke('get_hostname') and then
    // sendFrame inside Promise.all. Two scheduler turns drain that chain.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  it("sends one runner:register per project with documentId and a subscribe frame per project room", async () => {
    const { useWebSocket } = await import("@/hooks/use-web-socket");
    renderHook(() => useWebSocket(), { wrapper });

    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    });
    const ws = MockWebSocket.instances[0];
    await vi.waitFor(() => expect(typeof ws.onopen).toBe("function"));

    await act(async () => {
      ws.triggerOpen();
      await flushMicrotasks();
    });

    const frames = ws.sent.map((s) => JSON.parse(s));

    // Desktop registration frame (subscribe-device-room precondition).
    expect(frames).toContainEqual({ type: "desktop:register", deviceId: "dev-1" });
    expect(frames).toContainEqual({ type: "subscribe", room: "device:dev-1" });

    // ISS-175: project-room subscribes — one per documentId, not for proj-c.
    expect(frames).toContainEqual({ type: "subscribe", room: "project:doc-a" });
    expect(frames).toContainEqual({ type: "subscribe", room: "project:doc-b" });
    expect(frames).not.toContainEqual({ type: "subscribe", room: "project:proj-c" });

    // runner:register — exactly 2 frames, one per documentId.
    const registers = frames.filter((f: any) => f.type === "runner:register");
    expect(registers).toHaveLength(2);
    const projectIds = registers.map((f: any) => f.data.projectId).sort();
    expect(projectIds).toEqual(["doc-a", "doc-b"]);

    // Negative case: project without documentId — no runner:register frame
    // and no subscribe frame for it.
    expect(registers.find((f: any) => f.data.projectId === "proj-c")).toBeUndefined();
  });

  it("connects with bearer subprotocol so the token never leaks to the URL", async () => {
    const { useWebSocket } = await import("@/hooks/use-web-socket");
    renderHook(() => useWebSocket(), { wrapper });

    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe("ws://localhost:8080/ws");
    expect(ws.protocols).toEqual(["forge.bearer.jwt-token"]);
  });

  it("clears runner bindings when the browser socket closes (parity with ws:disconnected)", async () => {
    const { useWebSocket } = await import("@/hooks/use-web-socket");
    renderHook(() => useWebSocket(), { wrapper });

    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
    const ws = MockWebSocket.instances[0];
    await vi.waitFor(() => expect(typeof ws.onclose).toBe("function"));

    act(() => {
      ws.close();
    });

    expect(setWsConnected).toHaveBeenCalledWith(false);
    expect(clearRunnerBindings).toHaveBeenCalled();
  });
});
