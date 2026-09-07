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
  APP_BASE_URL: 'http://localhost:8080',
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

/**
 * ISS-961 — the one PAT bucket became two, so the old single-value knob has
 * nothing to mean. It refuses the boot rather than being ignored, because an
 * operator who set it did so to throttle a token and a schema that quietly
 * stops reading a key leaves that number silently unenforced.
 */
describe('config/env retired rate-limit variables', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, ...VALID_ENV };
    delete process.env.RATE_LIMIT_PAT_MAX;
    delete process.env.RATE_LIMIT_PAT_WINDOW_MS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('refuses the boot when RATE_LIMIT_PAT_MAX is set, naming both replacements', async () => {
    process.env.RATE_LIMIT_PAT_MAX = '600';
    await expect(import('./env.js')).rejects.toThrow(
      /RATE_LIMIT_PAT_MAX is retired; set RATE_LIMIT_PAT_READ_MAX and RATE_LIMIT_PAT_WRITE_MAX/,
    );
  });

  it('refuses the boot when RATE_LIMIT_PAT_WINDOW_MS is set, naming both replacements', async () => {
    process.env.RATE_LIMIT_PAT_WINDOW_MS = '60000';
    await expect(import('./env.js')).rejects.toThrow(
      /RATE_LIMIT_PAT_WINDOW_MS is retired; set RATE_LIMIT_PAT_READ_WINDOW_MS and RATE_LIMIT_PAT_WRITE_WINDOW_MS/,
    );
  });

  // cm:why an empty value is how `${VAR}` reaches a container for a variable the operator never set (see `cleanedEnv`), so treating it as "set" would refuse the boot of every deployment that merely lists the name.
  it('boots when a retired name is present but empty', async () => {
    process.env.RATE_LIMIT_PAT_MAX = '';
    const { env } = await import('./env.js');
    expect(env.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
  });

  it('reads the two replacement maxima', async () => {
    process.env.RATE_LIMIT_PAT_READ_MAX = '5000';
    process.env.RATE_LIMIT_PAT_WRITE_MAX = '700';
    const { env } = await import('./env.js');
    expect(env.RATE_LIMIT_PAT_READ_MAX).toBe(5000);
    expect(env.RATE_LIMIT_PAT_WRITE_MAX).toBe(700);
  });
});
