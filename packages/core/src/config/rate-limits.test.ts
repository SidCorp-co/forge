/**
 * ISS-961 — the two PAT buckets and the operator knobs that reach them.
 *
 * `resolve()` is three lines, but the knob it wires is the whole reason the
 * `${VAR}` lines in `docker-compose.prod.yml` exist: a variable the schema
 * reads and the rules ignore is the same silent no-op 8ff505af fixed for the
 * one this replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID_ENV = {
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  JWT_SECRET: 'x'.repeat(32),
  DEVICE_TOKEN_PEPPER: 'y'.repeat(32),
};

describe('config/rate-limits, the PAT pair', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, ...VALID_ENV };
    delete process.env.RATE_LIMIT_PAT_READ_MAX;
    delete process.env.RATE_LIMIT_PAT_READ_WINDOW_MS;
    delete process.env.RATE_LIMIT_PAT_WRITE_MAX;
    delete process.env.RATE_LIMIT_PAT_WRITE_WINDOW_MS;
    delete process.env.RATE_LIMIT_PAT_MAX;
    delete process.env.RATE_LIMIT_PAT_WINDOW_MS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // cm:guard the read budget must stay strictly ABOVE the write one, because the whole change is that a box of sessions reads more than one session writes. Equal numbers make the split pure overhead, and this is the assertion that says so.
  it('budgets reads for several sessions and writes for one, both keyed by token', async () => {
    const { RULES } = await import('./rate-limits.js');
    expect(RULES.patRead.by).toBe('token');
    expect(RULES.patWrite.by).toBe('token');
    expect(RULES.patRead.windowMs).toBe(60_000);
    expect(RULES.patWrite.windowMs).toBe(60_000);
    expect(RULES.patWrite.max).toBe(600);
    expect(RULES.patRead.max).toBeGreaterThan(RULES.patWrite.max);
  });

  it('lets RATE_LIMIT_PAT_READ_MAX and its window override the read bucket', async () => {
    process.env.RATE_LIMIT_PAT_READ_MAX = '5000';
    process.env.RATE_LIMIT_PAT_READ_WINDOW_MS = '30000';
    const { RULES } = await import('./rate-limits.js');
    expect(RULES.patRead).toEqual({ by: 'token', max: 5000, windowMs: 30_000 });
    expect(RULES.patWrite.max).toBe(600);
  });

  it('lets RATE_LIMIT_PAT_WRITE_MAX and its window override the write bucket', async () => {
    process.env.RATE_LIMIT_PAT_WRITE_MAX = '90';
    process.env.RATE_LIMIT_PAT_WRITE_WINDOW_MS = '10000';
    const { RULES } = await import('./rate-limits.js');
    expect(RULES.patWrite).toEqual({ by: 'token', max: 90, windowMs: 10_000 });
    expect(RULES.patRead.max).toBeGreaterThan(600);
  });

  it('maps each class to its own rule and nothing else', async () => {
    const { RULES, patRuleFor } = await import('./rate-limits.js');
    expect(patRuleFor('read')).toBe(RULES.patRead);
    expect(patRuleFor('write')).toBe(RULES.patWrite);
  });
});
