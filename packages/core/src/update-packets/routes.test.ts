import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';
vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectLeftJoin = vi.fn(
  (): Record<string, unknown> => ({
    leftJoin: selectLeftJoin,
    where: selectWhere,
  }),
);
const selectFrom = vi.fn(() => ({
  where: selectWhere,
  leftJoin: selectLeftJoin,
}));
vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

const createUpdatePacket = vi.fn();
vi.mock('../skills/update-packets.js', () => ({
  createUpdatePacket: (...args: unknown[]) => createUpdatePacket(...args),
}));

const { updatePacketRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{
    Variables: import('../middleware/request-id.js').RequestIdVars;
  }>();
  app.use('*', requestId());
  app.route('/api/update-packets', updatePacketRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectWhere.mockImplementation(() => ({ limit: selectLimit }));
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

const VALID_BODY = {
  change: 'diff-content',
  story: 'Drop the prod merge from forge-release: it broke prod for 10 days.',
  intentClass: 'invariant',
  appliesTo: 'forge-release',
};

const FAKE_PACKET = {
  id: 'packet-uuid-1',
  ...VALID_BODY,
  provenance: {},
  createdAt: new Date('2026-08-08T00:00:00Z').toISOString(),
};

describe('POST /api/update-packets', () => {
  it('401 when no token', async () => {
    const res = await buildApp().request('/api/update-packets', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('400 when story is missing', async () => {
    authVerified();
    const res = await buildApp().request('/api/update-packets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        change: 'diff',
        intentClass: 'procedure',
        appliesTo: 'forge-code',
      }),
    });
    expect(res.status).toBe(400);
    expect(createUpdatePacket).not.toHaveBeenCalled();
  });

  it('400 when story is whitespace-only', async () => {
    authVerified();
    const res = await buildApp().request('/api/update-packets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...VALID_BODY, story: '   ' }),
    });
    expect(res.status).toBe(400);
    expect(createUpdatePacket).not.toHaveBeenCalled();
  });

  it('201 with created packet on valid input, defaults trigger to manual', async () => {
    authVerified();
    createUpdatePacket.mockResolvedValueOnce(FAKE_PACKET);

    const res = await buildApp().request('/api/update-packets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe('packet-uuid-1');
    expect(createUpdatePacket).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        story: VALID_BODY.story,
        intentClass: 'invariant',
      }),
      expect.objectContaining({ actor: `human:${USER_ID}`, trigger: 'manual' }),
    );
  });

  it('passes explicit trigger through to the service', async () => {
    authVerified();
    createUpdatePacket.mockResolvedValueOnce(FAKE_PACKET);

    await buildApp().request('/api/update-packets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...VALID_BODY, trigger: 'cli' }),
    });
    expect(createUpdatePacket).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ trigger: 'cli' }),
    );
  });
});
