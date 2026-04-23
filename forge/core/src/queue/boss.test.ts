import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startMock = vi.fn(async () => {});
const stopMock = vi.fn(async () => {});

vi.mock('pg-boss', () => ({
  default: vi.fn(() => ({
    start: startMock,
    stop: stopMock,
  })),
}));

const VALID_ENV = {
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  JWT_SECRET: 'x'.repeat(32),
  DEVICE_TOKEN_PEPPER: 'y'.repeat(32),
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USER: 'user',
  SMTP_PASS: 'pass',
  SMTP_FROM: 'noreply@example.com',
  APP_BASE_URL: 'http://localhost:8080',
  CORS_ORIGINS: 'http://localhost:3000',
};

describe('queue/boss', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    startMock.mockClear();
    stopMock.mockClear();
    process.env = { ...originalEnv, ...VALID_ENV };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('exports the singleton and lifecycle helpers', async () => {
    const mod = await import('./boss.js');

    expect(mod.boss).toBeDefined();
    expect(typeof mod.startBoss).toBe('function');
    expect(typeof mod.stopBoss).toBe('function');
    expect(typeof mod.isBossStarted).toBe('function');
    expect(mod.isBossStarted()).toBe(false);
  });

  it('startBoss() starts the underlying client exactly once', async () => {
    const { startBoss, isBossStarted } = await import('./boss.js');

    await startBoss();
    await startBoss();

    expect(startMock).toHaveBeenCalledTimes(1);
    expect(isBossStarted()).toBe(true);
  });

  it('stopBoss() is a no-op before start, graceful-stops after start', async () => {
    const { startBoss, stopBoss, isBossStarted } = await import('./boss.js');

    await stopBoss();
    expect(stopMock).not.toHaveBeenCalled();

    await startBoss();
    await stopBoss();

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(stopMock).toHaveBeenCalledWith({ graceful: true });
    expect(isBossStarted()).toBe(false);
  });

  it('throws at import time when DATABASE_URL is missing', async () => {
    // biome-ignore lint/performance/noDelete: assigning undefined to process.env coerces to the string "undefined"
    delete process.env.DATABASE_URL;

    await expect(import('./boss.js')).rejects.toThrow(/DATABASE_URL/);
  });
});
