import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectOrderBy = vi.fn();
const selectWhere = vi.fn((_p: unknown) => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectFrom = vi.fn((_p: unknown) => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
  },
}));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const registryList = vi.fn();
vi.mock('../schedules/messages/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../schedules/messages/registry.js')>()),
  listImprovementMessages: (...args: unknown[]) => registryList(...args),
}));

const { improvementMessageRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/improvement-messages', improvementMessageRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SCHEDULE_ID = '33333333-3333-4333-8333-333333333333';

const MOCK_MESSAGE = {
  key: 'test-message',
  title: 'Test message',
  message: 'Do something',
  rationale: 'Because it helps',
  category: 'general' as const,
  version: 1,
  recommended: true,
  defaultMode: 'propose' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  projectAccess.mockReset();
  registryList.mockReset();
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/improvement-messages', () => {
  it('requires auth', async () => {
    const app = buildApp();
    const res = await app.request('/api/improvement-messages');
    expect(res.status).toBe(401);
  });

  it('returns catalog without projectId (no enablement)', async () => {
    authVerified();
    registryList.mockReturnValue([MOCK_MESSAGE]);

    const app = buildApp();
    const res = await app.request('/api/improvement-messages', {
      headers: { Authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json<Array<{ key: string; enablement: unknown }>>();
    expect(body).toHaveLength(1);
    expect(body[0].key).toBe('test-message');
    expect(body[0].enablement).toBeNull();
  });

  it('annotates catalog with enablement when projectId provided', async () => {
    authVerified();
    registryList.mockReturnValue([MOCK_MESSAGE]);
    projectAccess.mockResolvedValue({ role: 'admin' });

    const enabledRow = {
      id: SCHEDULE_ID,
      templateKey: 'test-message',
      mode: 'propose',
      cron: '0 9 * * *',
      enabled: true,
    };
    // Second selectLimit call is for the enabledRows query (first is auth check).
    selectLimit.mockResolvedValueOnce([enabledRow]);

    const app = buildApp();
    const res = await app.request(`/api/improvement-messages?projectId=${PROJECT_ID}`, {
      headers: { Authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json<
      Array<{ key: string; enablement: { scheduleId: string; enabled: boolean } | null }>
    >();
    expect(body).toHaveLength(1);
    expect(body[0].enablement).not.toBeNull();
    expect(body[0].enablement?.scheduleId).toBe(SCHEDULE_ID);
    expect(body[0].enablement?.enabled).toBe(true);
  });

  it('returns null enablement for messages not in schedules', async () => {
    authVerified();
    registryList.mockReturnValue([MOCK_MESSAGE]);
    projectAccess.mockResolvedValue({ role: 'admin' });
    // Second selectLimit call is for the enabledRows query.
    selectLimit.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await app.request(`/api/improvement-messages?projectId=${PROJECT_ID}`, {
      headers: { Authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json<Array<{ enablement: null }>>();
    expect(body[0].enablement).toBeNull();
  });

  it('rejects invalid projectId', async () => {
    authVerified();
    const app = buildApp();
    const res = await app.request('/api/improvement-messages?projectId=not-a-uuid', {
      headers: { Authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });
});
