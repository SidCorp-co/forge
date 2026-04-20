import { describe, expect, it, vi } from 'vitest';

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

const { app } = await import('./index.js');

describe('@forge/core health endpoint', () => {
  it('returns ok + queue + ws status on GET /health', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      queue: { ok: true },
      ws: { ok: true },
    });
  });
});
