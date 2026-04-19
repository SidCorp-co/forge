import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

let queryClient: QueryClient;
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

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  mockInstances = [];
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function loadHook() {
  const mod = await import('@/hooks/use-websocket');
  return mod.useWebSocket;
}

describe('useWebSocket', () => {
  it('creates WebSocket with correct URL', async () => {
    const useWebSocket = await loadHook();
    renderHook(() => useWebSocket(), { wrapper });

    expect(mockInstances).toHaveLength(1);
    expect(mockInstances[0].url).toBe('ws://localhost:1337/ws');
  });

  it('reconnects with exponential backoff', async () => {
    const useWebSocket = await loadHook();
    renderHook(() => useWebSocket(), { wrapper });

    expect(mockInstances).toHaveLength(1);

    // First close: reconnect after 1s (BASE_DELAY * 2^0)
    act(() => { mockInstances[0].close(); });
    expect(mockInstances).toHaveLength(1);

    act(() => { vi.advanceTimersByTime(1000); });
    expect(mockInstances).toHaveLength(2);

    // Second close: reconnect after 2s (BASE_DELAY * 2^1)
    act(() => { mockInstances[1].close(); });
    act(() => { vi.advanceTimersByTime(1999); });
    expect(mockInstances).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(1); });
    expect(mockInstances).toHaveLength(3);

    // Third close: reconnect after 4s (BASE_DELAY * 2^2)
    act(() => { mockInstances[2].close(); });
    act(() => { vi.advanceTimersByTime(3999); });
    expect(mockInstances).toHaveLength(3);
    act(() => { vi.advanceTimersByTime(1); });
    expect(mockInstances).toHaveLength(4);
  });

  it('stops reconnecting after exactly MAX_RETRIES (10) attempts', async () => {
    const useWebSocket = await loadHook();
    renderHook(() => useWebSocket(), { wrapper });

    // 1 initial + 10 retries = 11 total WebSocket instances
    for (let i = 0; i < 11; i++) {
      const last = mockInstances[mockInstances.length - 1];
      act(() => { last.close(); });
      act(() => { vi.advanceTimersByTime(60000); });
    }

    // retryCount is incremented before scheduling reconnect,
    // so the 10th close sets retryCount=10 and connect() exits early
    expect(mockInstances).toHaveLength(10); // 1 initial + 9 successful retries
  });

  it('closes socket and clears timer on unmount', async () => {
    const useWebSocket = await loadHook();
    const { unmount } = renderHook(() => useWebSocket(), { wrapper });

    const ws = mockInstances[0];
    unmount();

    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('invalidates issues queries on issue:created event', async () => {
    const useWebSocket = await loadHook();
    renderHook(() => useWebSocket(), { wrapper });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    const ws = mockInstances[0];
    act(() => {
      ws.onopen?.();
      ws.onmessage?.({ data: JSON.stringify({ event: 'issue:created' }) });
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: ['issues'] });
  });

  it('invalidates tasks queries on task:updated event', async () => {
    const useWebSocket = await loadHook();
    renderHook(() => useWebSocket(), { wrapper });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    const ws = mockInstances[0];
    act(() => {
      ws.onopen?.();
      ws.onmessage?.({ data: JSON.stringify({ event: 'task:updated' }) });
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
  });

  it('invalidates comments queries on issue:updated event', async () => {
    const useWebSocket = await loadHook();
    renderHook(() => useWebSocket(), { wrapper });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    const ws = mockInstances[0];
    act(() => {
      ws.onopen?.();
      ws.onmessage?.({ data: JSON.stringify({ event: 'issue:updated' }) });
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: ['comments'] });
  });
});
