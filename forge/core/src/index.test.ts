import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the env loader so importing `./index.js` does not require a full env
// (JWT_SECRET, SMTP_*, etc). Only PORT is used downstream.
vi.mock('./config/env.js', () => ({
  env: { PORT: 8080 },
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
}));

const { app } = await import('./index.js');
const { isBossStarted } = await import('./queue/boss.js');
const { isWsListening } = await import('./ws/server.js');
const { db } = await import('./db/client.js');

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
});
