import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef } from 'react';

let mockInstances: MockWebSocket[];

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    mockInstances.push(this);
  }

  send() {}

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

vi.mock('@/features/project/hooks/use-projects', () => ({
  useProjectBySlug: () => null,
}));

vi.mock('@/features/agent/api', () => ({
  agentApi: {
    desktopStatus: () => Promise.resolve({ data: { connected: false } }),
  },
}));

vi.mock('@/lib/api/client', () => ({
  WS_URL: 'ws://localhost:8080/ws',
}));

beforeEach(() => {
  mockInstances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function loadHook() {
  const mod = await import('@/hooks/use-agent-websocket');
  return mod.useAgentWebSocket;
}

function makeOpts() {
  // Built per-render so renderHook gets stable refs.
  const sessionIdRef = { current: null as string | null };
  const mountedRef = { current: true };
  const noop = vi.fn();
  return {
    projectSlug: 'p',
    sessionIdRef,
    mountedRef,
    dispatch: noop,
    handlePromptBuilt: noop,
    handlePreviewPrompt: noop,
  };
}

function harness(useAgentWebSocket: ReturnType<typeof loadHook> extends Promise<infer T> ? T : never) {
  return () => {
    const optsRef = useRef(makeOpts());
    return useAgentWebSocket(optsRef.current);
  };
}

describe('useAgentWebSocket', () => {
  it('starts in connecting state and flips to open on ws.onopen', async () => {
    const useAgentWebSocket = await loadHook();
    const { result } = renderHook(harness(useAgentWebSocket));

    expect(result.current.connectionState).toBe('connecting');
    expect(mockInstances).toHaveLength(1);

    act(() => { mockInstances[0].onopen?.(); });
    expect(result.current.connectionState).toBe('open');
  });

  it('flips to reconnecting on close and back to open after 2s + reopen', async () => {
    const useAgentWebSocket = await loadHook();
    const { result } = renderHook(harness(useAgentWebSocket));

    act(() => { mockInstances[0].onopen?.(); });
    expect(result.current.connectionState).toBe('open');

    act(() => { mockInstances[0].close(); });
    expect(result.current.connectionState).toBe('reconnecting');
    expect(mockInstances).toHaveLength(1);

    act(() => { vi.advanceTimersByTime(2000); });
    expect(mockInstances).toHaveLength(2);
    // State stays 'reconnecting' across retry attempts during an outage —
    // it only flips back to 'open' once the new handshake actually succeeds.
    expect(result.current.connectionState).toBe('reconnecting');

    act(() => { mockInstances[1].onopen?.(); });
    expect(result.current.connectionState).toBe('open');
  });

  it('reconnectNow cancels the pending timer and reconnects immediately', async () => {
    const useAgentWebSocket = await loadHook();
    const { result } = renderHook(harness(useAgentWebSocket));

    act(() => { mockInstances[0].onopen?.(); });
    act(() => { mockInstances[0].close(); });
    expect(result.current.connectionState).toBe('reconnecting');
    expect(mockInstances).toHaveLength(1);

    act(() => { result.current.reconnectNow(); });
    // Without advancing 2s, a new socket exists.
    expect(mockInstances).toHaveLength(2);

    // Advancing the original 2s timer must NOT fire a third socket — the
    // pending timer was cleared by reconnectNow.
    act(() => { vi.advanceTimersByTime(5000); });
    expect(mockInstances).toHaveLength(2);
  });

  it('reconnectNow during in-flight connect closes the stale socket (no orphan)', async () => {
    const useAgentWebSocket = await loadHook();
    const { result } = renderHook(harness(useAgentWebSocket));

    // Initial socket is in 'connecting' state — onopen has not fired.
    expect(result.current.connectionState).toBe('connecting');
    expect(mockInstances).toHaveLength(1);
    const stale = mockInstances[0];

    act(() => { result.current.reconnectNow(); });

    // Stale socket is closed (no orphan) and a fresh socket is created.
    expect(stale.readyState).toBe(MockWebSocket.CLOSED);
    expect(mockInstances).toHaveLength(2);
  });

  it('reconnectNow is a no-op when already open', async () => {
    const useAgentWebSocket = await loadHook();
    const { result } = renderHook(harness(useAgentWebSocket));

    act(() => { mockInstances[0].onopen?.(); });
    expect(result.current.connectionState).toBe('open');
    expect(mockInstances).toHaveLength(1);

    act(() => { result.current.reconnectNow(); });
    expect(mockInstances).toHaveLength(1);
  });

  it('StrictMode double-mount: deferred onclose from mount-1 does not clobber mount-2 socket or schedule a reconnect', async () => {
    // Reproduces the lifecycle bug where a shared `disposedRef` was reset to
    // false on mount-2's effect run, letting mount-1's deferred onclose see
    // disposed=false and schedule a reconnect against mount-2's live socket.
    const useAgentWebSocket = await loadHook();

    // Manually drive the StrictMode sequence: mount-1, cleanup-1, mount-2.
    const { unmount } = renderHook(harness(useAgentWebSocket));
    const ws1 = mockInstances[0];
    expect(mockInstances).toHaveLength(1);

    // Simulate StrictMode cleanup: unmount triggers ws1.close() which fires
    // ws1.onclose synchronously in our mock — but in real browsers this is
    // async. To simulate the real defer, detach onclose first, run cleanup,
    // then fire the deferred onclose by hand.
    const deferredOnClose = ws1.onclose;
    ws1.onclose = null;
    unmount();
    expect(ws1.readyState).toBe(MockWebSocket.CLOSED);

    // Re-mount the hook (mount-2). A fresh socket is created.
    const { result: result2 } = renderHook(harness(useAgentWebSocket));
    const ws2 = mockInstances[1];
    expect(mockInstances).toHaveLength(2);
    expect(ws2).not.toBe(ws1);

    // Now ws1's deferred onclose finally fires. Under the bug, this would
    // null wsRef.current (clobbering ws2) and schedule a reconnect.
    act(() => { deferredOnClose?.(); });

    // Advance past the buggy 2s reconnect schedule — no third socket.
    act(() => { vi.advanceTimersByTime(5000); });
    expect(mockInstances).toHaveLength(2);

    // mount-2's connection state is unaffected (still connecting since
    // ws2.onopen never fired in this test).
    expect(result2.current.connectionState).toBe('connecting');
  });

  it('on unmount: closes socket and stops scheduling reconnects', async () => {
    const useAgentWebSocket = await loadHook();
    const { unmount } = renderHook(harness(useAgentWebSocket));

    act(() => { mockInstances[0].onopen?.(); });
    unmount();

    expect(mockInstances[0].readyState).toBe(MockWebSocket.CLOSED);
    // Even after the 2s timer would have fired, no new sockets created.
    act(() => { vi.advanceTimersByTime(5000); });
    expect(mockInstances).toHaveLength(1);
  });
});
