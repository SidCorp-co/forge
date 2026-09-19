import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('importing a module that reaches db/client', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.DATABASE_URL;
    delete process.env.JWT_SECRET;
    delete process.env.DEVICE_TOKEN_PEPPER;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('does not throw with the three required variables absent', async () => {
    await expect(import('../knowledge/service.js')).resolves.toBeDefined();
  });

  it('reaches the service module rather than a partially evaluated graph', async () => {
    const service = await import('../knowledge/service.js');

    expect(typeof service).toBe('object');
    expect(Object.keys(service).length).toBeGreaterThan(0);
  });

  it('does not throw importing db/client itself', async () => {
    await expect(import('./client.js')).resolves.toBeDefined();
  });

  it('still refuses the missing variables when the database is actually reached', async () => {
    const { db } = await import('./client.js');

    expect(() => db.select).toThrow(/DATABASE_URL/);
  });
});
