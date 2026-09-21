import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const makeClient = () => {
  const client = Object.assign(function sql() {}, {
    end: vi.fn(async () => {}),
    unsafe: vi.fn(),
    begin: vi.fn(),
  });
  return client;
};
const postgresFactory = vi.fn(makeClient);
const drizzleFactory = vi.fn((client: unknown) => {
  const proto = {
    _tag: 'DrizzleInstance',
    select: function select(this: unknown) {
      return this;
    },
  };
  return Object.assign(Object.create(proto), { query: { issues: {} }, $client: client });
});

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

  it('binds a forwarded method to the real instance', async () => {
    const { db } = await import('./client.js');

    expect((db as unknown as { select: () => unknown }).select()).toBe(
      drizzleFactory.mock.results[0]?.value,
    );
  });

  it('hands back the same function object on two reads of one method', async () => {
    const { db } = await import('./client.js');

    expect(db.select).toBe(db.select);
  });

  it('closes without constructing a client when nothing touched db', async () => {
    const { closeDb } = await import('./client.js');

    await expect(closeDb()).resolves.toBeUndefined();
    expect(postgresFactory).not.toHaveBeenCalled();
  });

  it('closes the client that was constructed', async () => {
    const { db, closeDb } = await import('./client.js');
    void db.select;
    const client = postgresFactory.mock.results[0]?.value as unknown as {
      end: ReturnType<typeof vi.fn>;
    };

    await closeDb();

    expect(client.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it('hands back $client with its own methods intact', async () => {
    const { db } = await import('./client.js');

    const client = db.$client as unknown as { unsafe?: unknown; begin?: unknown; end?: unknown };
    expect(typeof client.unsafe).toBe('function');
    expect(typeof client.begin).toBe('function');
    expect(typeof client.end).toBe('function');
  });

  it('hands back the identical $client the driver was given', async () => {
    const { db } = await import('./client.js');

    expect(db.$client).toBe(postgresFactory.mock.results[0]?.value);
  });

  it('exports db', async () => {
    const mod = await import('./client.js');

    expect(Object.hasOwn(mod, 'db')).toBe(true);
  });
});
