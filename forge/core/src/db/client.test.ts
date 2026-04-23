import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the postgres driver and drizzle before importing client so no real
// TCP connection is attempted during the test run.
vi.mock('postgres', () => ({
  default: vi.fn(() => ({})),
}));

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => ({ _tag: 'DrizzleInstance' })),
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

describe('db/client', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, ...VALID_ENV };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('exports a drizzle client instance when DATABASE_URL is set', async () => {
    const { db } = await import('./client.js');

    expect(db).toBeDefined();
    expect(db).not.toBeNull();
  });

  it('exports the Db type (module shape is correct)', async () => {
    const mod = await import('./client.js');

    // The module must export `db` — the drizzle client singleton.
    expect(Object.prototype.hasOwnProperty.call(mod, 'db')).toBe(true);
  });
});
