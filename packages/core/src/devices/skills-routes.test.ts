import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_PEPPER = 'y'.repeat(32);

vi.mock('../config/env.js', () => ({
  env: { DEVICE_TOKEN_PEPPER: TEST_PEPPER, NODE_ENV: 'test' },
}));

const verifyDeviceToken = vi.fn(async (token: string) => {
  if (token === 'good') {
    return { id: 'dev-1', ownerId: 'u-1', status: 'offline', name: 'laptop', platform: 'linux' };
  }
  if (token === 'revoked') {
    return { id: 'dev-1', ownerId: 'u-1', status: 'revoked', name: 'laptop', platform: 'linux' };
  }
  return null;
});
vi.mock('../auth/deviceToken.js', () => ({
  verifyDeviceToken: (t: string) => verifyDeviceToken(t),
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const dbSelect = vi.fn(() => ({ from: selectFrom }));

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect },
}));

// The resolver is exercised by effective.test.ts; here we only assert the auth
// gates fire before it would ever run.
const resolveRegisteredEffectiveSkills = vi.fn(async () => [
  {
    skillId: 's-1',
    name: 'forge-code',
    version: 1,
    skillMd: '# md',
    files: [],
    effectiveHash: 'h1',
    isOverridden: false,
  },
]);
vi.mock('../skills/effective.js', () => ({
  resolveRegisteredEffectiveSkills: () => resolveRegisteredEffectiveSkills(),
  loadDeviceSkillStatus: vi.fn(async () => []),
  loadProjectSkillSyncStatus: vi.fn(async () => ({ devices: [], skills: [] })),
}));

const { deviceSkillRoutes } = await import('./skills-routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/devices', deviceSkillRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectWhere.mockImplementation(() => ({ limit: selectLimit }));
});

describe('GET /api/devices/me/skills', () => {
  it('401 with a bad device token', async () => {
    const res = await buildApp().request(`/api/devices/me/skills?projectId=${PROJECT_ID}`, {
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
  });

  it('401 when the device token is revoked', async () => {
    const res = await buildApp().request(`/api/devices/me/skills?projectId=${PROJECT_ID}`, {
      headers: { authorization: 'Bearer revoked' },
    });
    // verifyDeviceToken returns a revoked device row -> defence-in-depth 401.
    expect(res.status).toBe(401);
  });

  it('403 when the device is not bound to the project', async () => {
    selectLimit.mockResolvedValueOnce([]); // no runner row for (device, project)
    const res = await buildApp().request(`/api/devices/me/skills?projectId=${PROJECT_ID}`, {
      headers: { authorization: 'Bearer good' },
    });
    expect(res.status).toBe(403);
    expect(resolveRegisteredEffectiveSkills).not.toHaveBeenCalled();
  });

  it('200 manifest when bound', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'run-1' }]); // bound
    const res = await buildApp().request(`/api/devices/me/skills?projectId=${PROJECT_ID}`, {
      headers: { authorization: 'Bearer good' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skills: Array<{ skillId: string; effectiveHash: string }>;
    };
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0]?.effectiveHash).toBe('h1');
    // Lightweight manifest omits bodies unless includeFiles=1.
    expect((body.skills[0] as Record<string, unknown>).files).toBeUndefined();
  });
});
