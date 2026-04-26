import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
  },
}));

const { chatRoutes } = await import('./routes.js');
const { clearProviders, register } = await import('./providers/registry.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const { isEnabled } = await import('../lib/feature-flags.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

function buildApp(opts: { mountChat: boolean }) {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  if (opts.mountChat) {
    app.route('/api/chat', chatRoutes);
  }
  app.onError(errorHandler);
  return app;
}

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

function projectAccessAsMember() {
  selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: 'someone-else' }]);
  selectLimit.mockResolvedValueOnce([{ role: 'member' }]);
}

function appConfigRow(row: unknown) {
  selectLimit.mockResolvedValueOnce(row ? [row] : []);
}

async function token() {
  return signUserToken(USER_ID);
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  clearProviders();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('FEATURE_')) delete process.env[k];
  }
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('FEATURE_')) delete process.env[k];
  }
});

describe('feature flag gate', () => {
  it('chatProvider flag is off by default', () => {
    expect(isEnabled('chatProvider')).toBe(false);
  });

  it('returns 404 when route is not mounted (flag off)', async () => {
    const res = await buildApp({ mountChat: false }).request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT_ID, message: 'hi' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/chat (mounted)', () => {
  it('401 without token', async () => {
    const res = await buildApp({ mountChat: true }).request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT_ID, message: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('400 on invalid payload', async () => {
    authVerified();
    const res = await buildApp({ mountChat: true }).request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID }),
    });
    expect(res.status).toBe(400);
  });

  it('streams chunk + done events when provider is registered', async () => {
    register('mock', () => ({
      id: 'mock',
      defaultModel: 'mock-default',
      async *stream() {
        yield { type: 'chunk' as const, text: 'hi ' };
        yield { type: 'chunk' as const, text: 'there' };
        yield { type: 'done' as const };
      },
    }));

    authVerified();
    projectAccessAsMember();
    appConfigRow({ chatProviderId: 'mock', chatModel: null });

    const res = await buildApp({ mountChat: true }).request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, message: 'hi' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('event: chunk');
    expect(body).toContain('"text":"hi "');
    expect(body).toContain('"text":"there"');
    expect(body).toContain('event: done');
  });

  it('503 when no provider can be resolved', async () => {
    authVerified();
    projectAccessAsMember();
    appConfigRow(null);

    const res = await buildApp({ mountChat: true }).request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, message: 'hi' }),
    });

    expect(res.status).toBe(503);
  });
});
