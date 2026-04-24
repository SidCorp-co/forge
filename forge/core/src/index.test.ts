import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the env loader so importing `./index.js` does not require a full env
// (JWT_SECRET, SMTP_*, etc). Only PORT is used downstream.
vi.mock('./config/env.js', () => ({
  env: { PORT: 8080, CORS_ORIGINS: 'http://localhost:3000' },
}));

// Mock the pg-boss wrapper so importing `./index.js` does not construct a real
// PgBoss instance (which would require DATABASE_URL and attempt a connection).
vi.mock('./queue/boss.js', () => ({
  startBoss: vi.fn(async () => {}),
  stopBoss: vi.fn(async () => {}),
  isBossStarted: vi.fn(() => true),
  boss: {},
}));

vi.mock('./ws/server.js', () => ({
  attachWs: vi.fn(),
  closeWs: vi.fn(async () => {}),
  isWsListening: vi.fn(() => true),
  roomManager: {},
}));

vi.mock('./db/client.js', () => ({
  db: {
    execute: vi.fn(async () => [{ '?column?': 1 }]),
  },
  closeDb: vi.fn(async () => {}),
}));

const { app, runShutdown } = await import('./index.js');
const { isBossStarted, stopBoss } = await import('./queue/boss.js');
const { isWsListening, closeWs } = await import('./ws/server.js');
const { db, closeDb } = await import('./db/client.js');

describe('@forge/core health endpoint', () => {
  beforeEach(() => {
    vi.mocked(isBossStarted).mockReturnValue(true);
    vi.mocked(isWsListening).mockReturnValue(true);
    vi.mocked(db.execute).mockResolvedValue([{ '?column?': 1 }] as never);
  });

  it('returns 200 with db + queue + ws ok when all deps are healthy', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      db: { ok: true },
      queue: { ok: true },
      ws: { ok: true },
    });
  });

  it('returns 503 with db.ok=false when Postgres SELECT 1 fails', async () => {
    vi.mocked(db.execute).mockRejectedValueOnce(new Error('connection refused'));
    const res = await app.request('/health');
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      db: { ok: false },
      queue: { ok: true },
      ws: { ok: true },
    });
  });

  it('returns 503 with queue.ok=false when pg-boss is not started', async () => {
    vi.mocked(isBossStarted).mockReturnValue(false);
    const res = await app.request('/health');
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      db: { ok: true },
      queue: { ok: false },
      ws: { ok: true },
    });
  });

  it('sets x-request-id on every response', async () => {
    const res = await app.request('/health');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('returns { code, message } JSON for unknown routes', async () => {
    const res = await app.request('/no-such-route');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('NOT_FOUND');
    expect(body.message).toContain('/no-such-route');
  });
});

describe('@forge/core runShutdown', () => {
  it('runs closeWs, stopBoss, server.close, closeDb in order and returns 0', async () => {
    const order: string[] = [];
    vi.mocked(closeWs).mockImplementationOnce(async () => {
      order.push('ws');
    });
    vi.mocked(stopBoss).mockImplementationOnce(async () => {
      order.push('boss');
    });
    vi.mocked(closeDb).mockImplementationOnce(async () => {
      order.push('db');
    });

    const server = {
      close: vi.fn((cb?: (err?: Error) => void) => {
        order.push('http');
        cb?.();
      }),
    };

    const code = await runShutdown('SIGTERM', server);

    expect(code).toBe(0);
    // server.close() is called to stop accepting new connections
    expect(server.close).toHaveBeenCalledTimes(1);
    // All shutdown stages ran, and DB pool closes last (after everything else).
    expect(order).toContain('ws');
    expect(order).toContain('boss');
    expect(order).toContain('http');
    expect(order[order.length - 1]).toBe('db');
    // WS clients are notified before pg-boss drains so in-flight jobs don't
    // try to broadcast to closing sockets.
    expect(order.indexOf('ws')).toBeLessThan(order.indexOf('boss'));
  });

  it('returns 1 when the shutdown sequence exceeds the timeout', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(closeWs).mockImplementationOnce(
        () => new Promise(() => {}), // never resolves
      );
      const server = {
        close: vi.fn((cb?: (err?: Error) => void) => {
          cb?.();
        }),
      };

      const p = runShutdown('SIGTERM', server);
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(p).resolves.toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
