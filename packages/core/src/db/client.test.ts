import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// cm:guard the postgres driver and drizzle are stubbed so the cases below can COUNT construction
// rather than only observe that something came back. The counting is the whole point: "importing
// this module does no work" is a claim about how many times the factory ran, and a test that only
// asserts `db` is defined cannot tell a lazy client from an eager one (ISS-1067).
const postgresFactory = vi.fn(() => ({ end: vi.fn(async () => {}) }));
const drizzleFactory = vi.fn(() => ({
  _tag: 'DrizzleInstance',
  select: function select() {
    return this;
  },
  query: { issues: {} },
}));

vi.mock('postgres', () => ({ default: postgresFactory }));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: drizzleFactory }));

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
    postgresFactory.mockClear();
    drizzleFactory.mockClear();
    process.env = { ...originalEnv, ...VALID_ENV };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('constructs no client at import', async () => {
    await import('./client.js');

    expect(postgresFactory).not.toHaveBeenCalled();
    expect(drizzleFactory).not.toHaveBeenCalled();
  });

  it('constructs the client on the first property read', async () => {
    const { db } = await import('./client.js');

    void db.select;

    expect(postgresFactory).toHaveBeenCalledTimes(1);
  });

  it('constructs the client once across two property reads', async () => {
    const { db } = await import('./client.js');

    void db.select;
    void db.query;

    expect(postgresFactory).toHaveBeenCalledTimes(1);
    expect(drizzleFactory).toHaveBeenCalledTimes(1);
  });

  it('passes the two statement timeouts to the driver', async () => {
    const { db } = await import('./client.js');

    void db.select;

    expect(postgresFactory).toHaveBeenCalledWith(
      VALID_ENV.DATABASE_URL,
      expect.objectContaining({
        connection: expect.objectContaining({
          statement_timeout: 60_000,
          idle_in_transaction_session_timeout: 30_000,
        }),
      }),
    );
  });

  // cm:guard a method reaches the caller BOUND to the real instance. Unbound, `this` inside a
  // drizzle builder would be the proxy, and the proxy's target is an empty object — so every read
  // of private state off `this` would answer undefined rather than throw, which is the silent half.
  it('binds a forwarded method to the real instance', async () => {
    const { db } = await import('./client.js');

    expect((db as unknown as { select: () => unknown }).select()).toBe(drizzleFactory.mock.results[0]?.value);
  });

  it('hands back the same function object on two reads of one method', async () => {
    const { db } = await import('./client.js');

    expect(db.select).toBe(db.select);
  });

  // cm:guard closing what was never opened must not OPEN it. A shutdown path that constructs a pool
  // in order to end it is how a process that held no connection acquires one on its way out.
  it('closes without constructing a client when nothing touched db', async () => {
    const { closeDb } = await import('./client.js');

    await expect(closeDb()).resolves.toBeUndefined();
    expect(postgresFactory).not.toHaveBeenCalled();
  });

  it('closes the client that was constructed', async () => {
    const { db, closeDb } = await import('./client.js');
    void db.select;
    const client = postgresFactory.mock.results[0]?.value as { end: ReturnType<typeof vi.fn> };

    await closeDb();

    expect(client.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it('exports db', async () => {
    const mod = await import('./client.js');

    expect(Object.hasOwn(mod, 'db')).toBe(true);
  });
});
