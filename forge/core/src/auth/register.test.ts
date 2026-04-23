import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {},
}));

const insertValues = vi.fn();
const insertReturning = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    insert: vi.fn(() => ({
      values: insertValues,
    })),
  },
}));

vi.mock('./password.js', () => ({
  hashPassword: vi.fn(async (plain: string) => `hashed:${plain}`),
}));

vi.mock('./verification-token.js', () => ({
  issueVerificationToken: vi.fn(async () => 'tok-mock'),
}));

vi.mock('./email.js', () => ({
  sendVerificationEmail: vi.fn(async () => undefined),
}));

const { authRoutes } = await import('./register.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const { db } = await import('../db/client.js');
const { hashPassword } = await import('./password.js');
const { issueVerificationToken } = await import('./verification-token.js');
const { sendVerificationEmail } = await import('./email.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/auth', authRoutes);
  app.onError(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  insertValues.mockReset();
  insertReturning.mockReset();
  insertValues.mockImplementation(() => ({ returning: insertReturning }));
});

describe('POST /api/auth/register', () => {
  it('returns 201 with { userId, email } on valid input', async () => {
    insertReturning.mockResolvedValueOnce([{ userId: 'uuid-1', email: 'a@b.co' }]);

    const res = await buildApp().request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.co', password: 'password1' }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ userId: 'uuid-1', email: 'a@b.co' });
    expect(hashPassword).toHaveBeenCalledWith('password1');
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith({
      email: 'a@b.co',
      passwordHash: 'hashed:password1',
    });
    // emailVerifiedAt not set — DB default (null) applies.
    const values = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.emailVerifiedAt).toBeUndefined();
    expect(issueVerificationToken).toHaveBeenCalledWith('uuid-1');
    expect(sendVerificationEmail).toHaveBeenCalledWith('a@b.co', 'tok-mock');
  });

  it('still returns 201 when sending the verification email fails', async () => {
    insertReturning.mockResolvedValueOnce([{ userId: 'uuid-flaky', email: 'f@b.co' }]);
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(new Error('smtp down'));

    const res = await buildApp().request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'f@b.co', password: 'password1' }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ userId: 'uuid-flaky', email: 'f@b.co' });
    expect(sendVerificationEmail).toHaveBeenCalled();
  });

  it('returns 409 when email already exists (pg unique_violation)', async () => {
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' });
    insertReturning.mockRejectedValueOnce(pgError);

    const res = await buildApp().request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dup@b.co', password: 'password1' }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('CONFLICT');
  });

  it('returns 400 on invalid email', async () => {
    const res = await buildApp().request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'password1' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; details?: unknown };
    expect(body.code).toBe('BAD_REQUEST');
    expect(body.details).toBeDefined();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('returns 400 on weak password (<8 chars)', async () => {
    const res = await buildApp().request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.co', password: 'short' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('lowercases and trims the email before insert', async () => {
    insertReturning.mockResolvedValueOnce([{ userId: 'uuid-2', email: 'foo@bar.com' }]);

    const res = await buildApp().request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: '  Foo@Bar.COM  ', password: 'password1' }),
    });

    expect(res.status).toBe(201);
    expect(insertValues).toHaveBeenCalledWith({
      email: 'foo@bar.com',
      passwordHash: 'hashed:password1',
    });
  });
});
