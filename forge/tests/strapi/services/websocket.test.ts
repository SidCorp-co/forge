import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket as RealWebSocket } from 'ws';

// Mock ws module
vi.mock('ws', () => {
  const OPEN = 1;
  const CLOSED = 3;

  class MockWebSocket {
    readyState: number;
    send = vi.fn();
    on = vi.fn();
    constructor(readyState = OPEN) {
      this.readyState = readyState;
    }
    static OPEN = OPEN;
    static CLOSED = CLOSED;
  }

  // Track the last created instance so tests can access it
  let lastInstance: any = null;

  class MockWebSocketServer {
    clients = new Set<MockWebSocket>();
    on = vi.fn();
    constructor(opts: any) {
      (MockWebSocketServer as any).__lastOpts = opts;
      lastInstance = this;
    }
    static __getLastInstance() {
      return lastInstance;
    }
  }

  return {
    WebSocketServer: MockWebSocketServer,
    WebSocket: MockWebSocket,
  };
});

describe('WebSocket Service', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('initWebSocket should create server with /ws path', async () => {
    const { WebSocketServer } = await import('ws');
    const { initWebSocket } = await import('../../../strapi/src/services/websocket');

    const mockStrapi = {
      server: { httpServer: {} },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    initWebSocket(mockStrapi);

    // Verify the WebSocketServer was created with path '/ws'
    const lastOpts = (WebSocketServer as any).__lastOpts;
    expect(lastOpts).toBeDefined();
    expect(lastOpts.path).toBe('/ws');
    expect(mockStrapi.log.info).toHaveBeenCalledWith('WebSocket server started on /ws');
  });

  it('initWebSocket should warn if no HTTP server', async () => {
    const { initWebSocket } = await import('../../../strapi/src/services/websocket');

    const mockStrapi = {
      server: { httpServer: null },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    initWebSocket(mockStrapi);

    expect(mockStrapi.log.warn).toHaveBeenCalledWith('No HTTP server found, WebSocket disabled');
  });

  it('broadcast should send to OPEN clients and skip CLOSED clients', async () => {
    const { WebSocketServer, WebSocket } = await import('ws');
    const { initWebSocket, broadcast } = await import('../../../strapi/src/services/websocket');

    const mockStrapi = {
      server: { httpServer: {} },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    initWebSocket(mockStrapi);

    // Get the wss instance and add mock clients
    const wss = (WebSocketServer as any).__getLastInstance();

    const openClient = { readyState: (WebSocket as any).OPEN, send: vi.fn() };
    const closedClient = { readyState: (WebSocket as any).CLOSED, send: vi.fn() };
    wss.clients.add(openClient);
    wss.clients.add(closedClient);

    broadcast('test:event', { data: 'test' });

    expect(openClient.send).toHaveBeenCalledOnce();
    const sentMessage = JSON.parse(openClient.send.mock.calls[0][0]);
    expect(sentMessage.event).toBe('test:event');
    expect(sentMessage.data).toEqual({ data: 'test' });

    expect(closedClient.send).not.toHaveBeenCalled();
  });

  it('broadcast with null wss should not crash', async () => {
    // Fresh import without calling initWebSocket
    const { broadcast } = await import('../../../strapi/src/services/websocket');

    expect(() => broadcast('test:event', { data: 'test' })).not.toThrow();
  });

  it('should register error and connection handlers on wss', async () => {
    const { WebSocketServer } = await import('ws');
    const { initWebSocket } = await import('../../../strapi/src/services/websocket');

    const mockStrapi = {
      server: { httpServer: {} },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;

    initWebSocket(mockStrapi);

    const wss = (WebSocketServer as any).__getLastInstance();

    // Verify wss.on was called with 'error' and 'connection'
    const onCalls = wss.on.mock.calls.map((c: any) => c[0]);
    expect(onCalls).toContain('error');
    expect(onCalls).toContain('connection');
  });
});
