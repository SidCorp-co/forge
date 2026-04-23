import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID_ENV = {
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  JWT_SECRET: 'x'.repeat(32),
  DEVICE_TOKEN_PEPPER: 'y'.repeat(32),
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USER: 'user',
  SMTP_PASS: 'pass',
  SMTP_FROM: 'noreply@example.com',
  CORS_ORIGINS: 'http://localhost:3000',
};

describe('config/env', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, ...VALID_ENV };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('parses a valid environment and exports a typed env object', async () => {
    const { env } = await import('./env.js');

    expect(env.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
    expect(env.JWT_SECRET).toHaveLength(32);
    expect(env.PORT).toBe(8080);
    expect(env.NODE_ENV).toBe(process.env.NODE_ENV ?? 'development');
  });

  it('coerces numeric strings to numbers', async () => {
    process.env.PORT = '9000';
    process.env.SMTP_PORT = '2525';

    const { env } = await import('./env.js');

    expect(env.PORT).toBe(9000);
    expect(env.SMTP_PORT).toBe(2525);
  });

  it('throws at import time when a required var is missing', async () => {
    // biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined"
    delete process.env.JWT_SECRET;

    await expect(import('./env.js')).rejects.toThrow(/JWT_SECRET/);
  });

  it('throws at import time when DATABASE_URL is not a valid URL', async () => {
    process.env.DATABASE_URL = 'not-a-url';

    await expect(import('./env.js')).rejects.toThrow(/DATABASE_URL/);
  });

  it('throws when secrets are shorter than the minimum length', async () => {
    process.env.DEVICE_TOKEN_PEPPER = 'short';

    await expect(import('./env.js')).rejects.toThrow(/DEVICE_TOKEN_PEPPER/);
  });
});
