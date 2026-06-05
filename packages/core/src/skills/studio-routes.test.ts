import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectOrderBy = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

// Mock the service so the apply-default route is tested at the route layer; the
// thrown error class is exported from the same mock so `instanceof` matches.
class SkillAlreadyShadowedError extends Error {
  readonly code = 'ALREADY_SHADOWED';
  constructor(name: string) {
    super(`ALREADY_SHADOWED: a project skill named '${name}' already exists`);
    this.name = 'SkillAlreadyShadowedError';
  }
}
const applyGlobalSkillDefault = vi.fn();
vi.mock('./service.js', () => ({
  SkillAlreadyShadowedError,
  applyGlobalSkillDefault: (...args: unknown[]) => applyGlobalSkillDefault(...args),
}));

const { skillStudioRoutes } = await import('./studio-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', skillStudioRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const GLOBAL_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT_SKILL_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderBy.mockReset();
  selectWhere.mockImplementation(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/projects/:projectId/skills/effective', () => {
  it('403 when caller is not a project member', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ ownerId: 'someone-else' }]); // project
    selectLimit.mockResolvedValueOnce([]); // member -> none

    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/skills/effective`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });

  it('lists globals (read-only) + project skills with shadow annotations', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ ownerId: USER_ID }]); // project
    selectLimit.mockResolvedValueOnce([{ role: 'owner' }]); // member
    // globals select.orderBy
    selectOrderBy.mockResolvedValueOnce([
      { id: GLOBAL_ID, name: 'forge-code', scope: 'global', skillMd: 'GLOBAL', prompt: null, files: [] },
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'forge-plan', scope: 'global', skillMd: 'PLAN', prompt: null, files: [] },
    ]);
    // project skills select.orderBy
    selectOrderBy.mockResolvedValueOnce([
      { id: PROJECT_SKILL_ID, name: 'forge-code', scope: 'project', projectId: PROJECT_ID, skillMd: 'PROJECT', files: [] },
    ]);

    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/skills/effective`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      name: string;
      editable: boolean;
      shadowsGlobal: boolean;
      shadowedGlobalSkillId: string | null;
      shadowedByProjectSkillId: string | null;
    }>;
    // 2 globals + 1 project skill, NOT deduped.
    expect(body).toHaveLength(3);

    const globalCode = body.find((b) => b.id === GLOBAL_ID)!;
    expect(globalCode.editable).toBe(false);
    expect(globalCode.shadowedByProjectSkillId).toBe(PROJECT_SKILL_ID);

    const globalPlan = body.find((b) => b.name === 'forge-plan')!;
    expect(globalPlan.shadowedByProjectSkillId).toBeNull();

    const projectCode = body.find((b) => b.id === PROJECT_SKILL_ID)!;
    expect(projectCode.editable).toBe(true);
    expect(projectCode.shadowsGlobal).toBe(true);
    expect(projectCode.shadowedGlobalSkillId).toBe(GLOBAL_ID);
  });
});

describe('POST /api/projects/:projectId/skills/apply-default', () => {
  it('201 creates a same-name project copy from the global template', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ ownerId: USER_ID }]); // project
    selectLimit.mockResolvedValueOnce([{ role: 'admin' }]); // member
    selectLimit.mockResolvedValueOnce([
      { id: GLOBAL_ID, name: 'forge-code', scope: 'global', skillMd: 'GLOBAL', prompt: null, files: [] },
    ]); // global lookup
    applyGlobalSkillDefault.mockResolvedValueOnce({
      id: PROJECT_SKILL_ID,
      name: 'forge-code',
      scope: 'project',
    });

    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/skills/apply-default`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ globalSkillId: GLOBAL_ID }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; scope: string };
    expect(body.id).toBe(PROJECT_SKILL_ID);
    expect(body.scope).toBe('project');
    expect(applyGlobalSkillDefault).toHaveBeenCalledOnce();
  });

  it('400 ALREADY_SHADOWED when a same-name project skill exists', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ ownerId: USER_ID }]); // project
    selectLimit.mockResolvedValueOnce([{ role: 'owner' }]); // member
    selectLimit.mockResolvedValueOnce([
      { id: GLOBAL_ID, name: 'forge-code', scope: 'global', skillMd: 'GLOBAL', prompt: null, files: [] },
    ]); // global lookup
    applyGlobalSkillDefault.mockRejectedValueOnce(new SkillAlreadyShadowedError('forge-code'));

    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/skills/apply-default`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ globalSkillId: GLOBAL_ID }),
    });
    expect(res.status).toBe(400);
  });

  it('400 when the source skill is not global', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ ownerId: USER_ID }]); // project
    selectLimit.mockResolvedValueOnce([{ role: 'owner' }]); // member
    selectLimit.mockResolvedValueOnce([
      { id: GLOBAL_ID, name: 'forge-code', scope: 'project', projectId: PROJECT_ID },
    ]); // not a global

    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/skills/apply-default`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ globalSkillId: GLOBAL_ID }),
    });
    expect(res.status).toBe(400);
    expect(applyGlobalSkillDefault).not.toHaveBeenCalled();
  });
});
