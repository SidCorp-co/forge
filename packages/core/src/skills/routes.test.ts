import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Device-token route: `POST /api/projects/:projectId/skills/sync` (skillSyncRoutes).
// Focused on the meta-skill reservation guard (ISS-741 / task 703cc186) — this
// device-token path writes `skills` directly, so it must reject a reserved meta
// name just like the user-token service paths do.

const TEST_PEPPER = 'y'.repeat(32);
vi.mock('../config/env.js', () => ({
  env: { DEVICE_TOKEN_PEPPER: TEST_PEPPER, NODE_ENV: 'test' },
}));

const verifyDeviceToken = vi.fn(async (token: string) =>
  token === 'good'
    ? { id: 'dev-1', ownerId: 'u-1', status: 'offline', name: 'laptop', platform: 'linux' }
    : null,
);
vi.mock('../auth/deviceToken.js', () => ({
  verifyDeviceToken: (t: string) => verifyDeviceToken(t),
}));

// Device owner is a project admin (passes both the partial- and full-mode role checks).
vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: vi.fn(async () => ({ role: 'admin' })),
  projectRoleAtLeast: () => true,
  assertProjectRole: vi.fn(),
}));

const transaction = vi.fn(async () => ({
  diff: { unchanged: [], toRemove: [], toInsert: [], toUpdate: [] },
  added: [],
  updated: [],
}));
vi.mock('../db/client.js', () => ({ db: { transaction } }));

const emit = vi.fn(async () => {});
vi.mock('../pipeline/hooks.js', () => ({ hooks: { emit } }));

// The register/CRUD helpers are imported by the module but unused on this path.
vi.mock('./service.js', () => ({
  SkillDeleteBlockedError: class extends Error {},
  SkillNotProjectScopedError: class extends Error {},
  getSkillForProject: vi.fn(),
  registerSkillForProject: vi.fn(),
}));

const { skillSyncRoutes } = await import('./routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono();
  app.use('*', requestId());
  app.route('/api/projects', skillSyncRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

function post(skills: Array<{ name: string; prompt: string; hash: string }>) {
  return buildApp().request(`/api/projects/${PROJECT_ID}/skills/sync`, {
    method: 'POST',
    headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'partial', skills }),
  });
}

beforeEach(() => vi.clearAllMocks());

describe('POST /api/projects/:projectId/skills/sync — meta-skill guard', () => {
  it('rejects a reserved meta name (forge-onboard) with 403 and never writes', async () => {
    const res = await post([{ name: 'forge-onboard', prompt: '# x', hash: 'abcd1234' }]);
    expect(res.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects the batch if ANY skill is a reserved meta name', async () => {
    const res = await post([
      { name: 'forge-code', prompt: '# a', hash: 'aaaa1111' },
      { name: 'forge-onboard', prompt: '# b', hash: 'bbbb2222' },
    ]);
    expect(res.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('allows an ordinary project skill (passes the guard, writes)', async () => {
    const res = await post([{ name: 'forge-code', prompt: '# x', hash: 'abcd1234' }]);
    expect(res.status).toBe(200);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
