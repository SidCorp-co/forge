import { describe, expect, it, vi } from 'vitest';

// Stub the postgres driver and drizzle before importing client so no real
// TCP connection is attempted during the test run.
vi.mock('postgres', () => ({
  default: vi.fn(() => ({})),
}));

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => ({ _tag: 'DrizzleInstance' })),
}));

describe('db/client', () => {
  it('exports a drizzle client instance when DATABASE_URL is set', async () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';

    const { db } = await import('./client.js');

    expect(db).toBeDefined();
    expect(db).not.toBeNull();
  });

  it('exports the Db type (module shape is correct)', async () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';

    const mod = await import('./client.js');

    // The module must export `db` — the drizzle client singleton.
    expect(Object.prototype.hasOwnProperty.call(mod, 'db')).toBe(true);
  });
});
