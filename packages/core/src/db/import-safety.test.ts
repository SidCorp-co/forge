import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The failure this reproduces, from CI on PR #457 (2026-09-16 22:36Z):
 *
 *     ❯ src/config/env.ts:137:9
 *     ❯ src/db/client.ts:3:1
 *     ❯ src/knowledge/service.ts:3:1
 *
 * `tests/integration/knowledge-slug-obligation-body-e2e.test.ts` reported "3 tests | 3 skipped" —
 * no assertion, no test name, nothing to read. Importing the service pulled `db/client.ts`, which
 * pulled `config/env.ts`, which threw at module scope because the integration config carries no
 * setupFiles and the three required variables were not in that worker's environment.
 *
 * Nothing here mocks `db/client.js` or `config/env.js`. That is the point: the whole claim is about
 * what a REAL import does, and a factory mock would replace the module and never evaluate it, so a
 * green run under one would be evidence of nothing (ISS-1067).
 */
describe('importing a module that reaches db/client', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    // cm:guard vitest.setup.ts floors these three for the unit suite with `??=`, so they are set by
    // the time any case runs. Deleting them here is what puts this case in the integration suite's
    // position — the one with no floor, where the throw actually happened.
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
