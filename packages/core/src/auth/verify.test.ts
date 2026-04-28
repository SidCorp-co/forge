import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const consumeVerificationToken = vi.fn();

vi.mock('./verification-token.js', () => ({
  consumeVerificationToken,
}));

const { verifyRoutes } = await import('./verify.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/auth', verifyRoutes);
  app.onError(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/auth/verify', () => {
  it('returns 200 { verified: true } on ok', async () => {
    consumeVerificationToken.mockResolvedValueOnce('ok');
    const res = await buildApp().request('/api/auth/verify?token=good');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ verified: true });
    expect(consumeVerificationToken).toHaveBeenCalledWith('good');
  });

  it('returns 400 INVALID_TOKEN on null result', async () => {
    consumeVerificationToken.mockResolvedValueOnce(null);
    const res = await buildApp().request('/api/auth/verify?token=missing');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_TOKEN');
  });

  it('returns 400 TOKEN_EXPIRED on expired result', async () => {
    consumeVerificationToken.mockResolvedValueOnce('expired');
    const res = await buildApp().request('/api/auth/verify?token=old');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('TOKEN_EXPIRED');
  });

  it('returns 400 INVALID_TOKEN when token query is missing', async () => {
    const res = await buildApp().request('/api/auth/verify');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_TOKEN');
    expect(consumeVerificationToken).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/verify', () => {
  it('accepts token from JSON body', async () => {
    consumeVerificationToken.mockResolvedValueOnce('ok');
    const res = await buildApp().request('/api/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'body-token' }),
    });
    expect(res.status).toBe(200);
    expect(consumeVerificationToken).toHaveBeenCalledWith('body-token');
  });

  it('accepts token from query when body is absent', async () => {
    consumeVerificationToken.mockResolvedValueOnce('ok');
    const res = await buildApp().request('/api/auth/verify?token=query-token', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(consumeVerificationToken).toHaveBeenCalledWith('query-token');
  });

  it('returns 400 INVALID_TOKEN when token is absent everywhere', async () => {
    const res = await buildApp().request('/api/auth/verify', { method: 'POST' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_TOKEN');
  });
});
