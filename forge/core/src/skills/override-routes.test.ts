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
const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const deleteReturning = vi.fn();
const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => ({ where: deleteWhere })),
  },
}));

const emit = vi.fn(async () => undefined);
vi.mock('../pipeline/hooks.js', () => ({
  hooks: { emit },
}));

const { skillOverrideRoutes } = await import('./override-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', skillOverrideRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SKILL_ID = '33333333-3333-4333-8333-333333333333';
const OVERRIDE_ID = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderBy.mockReset();
  selectWhere.mockReset();
  insertReturning.mockReset();
  updateReturning.mockReset();
  deleteReturning.mockReset();
  emit.mockClear();

  // selectWhere is the chain element callers spread on; reset its default
  // return so each test re-supplies the next-step mocks fresh.
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
    selectLimit.mockResolvedValueOnce([{ ownerId: 'someone-else' }]); // project lookup
    selectLimit.mockResolvedValueOnce([]); // member lookup -> not member

    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/skills/effective`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });

  it('returns merged list with isOverridden flag', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ ownerId: USER_ID }]); // project
    selectLimit.mockResolvedValueOnce([{ role: 'owner' }]); // member
    // Two select chains end in `.orderBy(...)`: globals + overrides.
    selectOrderBy.mockResolvedValueOnce([
      { id: SKILL_ID, name: 'forge-code', scope: 'global', skillMd: 'GLOBAL', contentHash: 'g1' },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'forge-fix',
        scope: 'global',
        skillMd: 'GLOBAL2',
        contentHash: 'g2',
      },
    ]);
    selectOrderBy.mockResolvedValueOnce([
      {
        id: OVERRIDE_ID,
        projectId: PROJECT_ID,
        skillId: SKILL_ID,
        skillMdOverride: 'PROJECT-LOCAL',
        contentHash: 'p1',
        updatedAt: new Date(),
      },
    ]);

    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/skills/effective`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      name: string;
      isOverridden: boolean;
      skillMd: string;
    }>;
    expect(body).toHaveLength(2);
    const code = body.find((b) => b.name === 'forge-code');
    expect(code?.isOverridden).toBe(true);
    expect(code?.skillMd).toBe('PROJECT-LOCAL');
    const fix = body.find((b) => b.name === 'forge-fix');
    expect(fix?.isOverridden).toBe(false);
    expect(fix?.skillMd).toBe('GLOBAL2');
  });
});

describe('PUT /api/projects/:projectId/skills/:skillId/override', () => {
  it('403 when caller is plain member (not owner/admin)', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ ownerId: 'other' }]); // project
    selectLimit.mockResolvedValueOnce([{ role: 'member' }]); // member

    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/skills/${SKILL_ID}/override`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await token()}`,
        },
        body: JSON.stringify({ skillMdOverride: 'override md' }),
      },
    );
    expect(res.status).toBe(403);
    expect(emit).not.toHaveBeenCalled();
  });

  it('400 when target skill is not global', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ ownerId: USER_ID }]); // project
    selectLimit.mockResolvedValueOnce([{ role: 'owner' }]); // member
    selectLimit.mockResolvedValueOnce([
      { id: SKILL_ID, name: 'forge-code', scope: 'project' }, // not global
    ]);

    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/skills/${SKILL_ID}/override`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await token()}`,
        },
        body: JSON.stringify({ skillMdOverride: 'override md' }),
      },
    );
    expect(res.status).toBe(400);
  });

  it('inserts new override and emits skillUpdated when no row exists', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ ownerId: USER_ID }]); // project
    selectLimit.mockResolvedValueOnce([{ role: 'owner' }]); // member
    selectLimit.mockResolvedValueOnce([
      { id: SKILL_ID, name: 'forge-code', scope: 'global' },
    ]); // global skill lookup
    selectLimit.mockResolvedValueOnce([]); // existing override lookup -> none
    insertReturning.mockResolvedValueOnce([
      {
        id: OVERRIDE_ID,
        projectId: PROJECT_ID,
        skillId: SKILL_ID,
        skillMdOverride: 'override md',
        contentHash: 'hash',
      },
    ]);

    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/skills/${SKILL_ID}/override`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await token()}`,
        },
        body: JSON.stringify({ skillMdOverride: 'override md' }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(OVERRIDE_ID);
    expect(emit).toHaveBeenCalledWith(
      'skillUpdated',
      expect.objectContaining({
        projectId: PROJECT_ID,
        skillId: SKILL_ID,
        name: 'forge-code',
        action: 'upsert',
      }),
    );
  });
});

describe('DELETE /api/projects/:projectId/skills/:skillId/override', () => {
  it('204 and emits skillUpdated when override exists', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ ownerId: USER_ID }]); // project
    selectLimit.mockResolvedValueOnce([{ role: 'owner' }]); // member
    selectLimit.mockResolvedValueOnce([
      { id: SKILL_ID, name: 'forge-code', scope: 'global' },
    ]); // global skill
    deleteReturning.mockResolvedValueOnce([{ id: OVERRIDE_ID }]);

    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/skills/${SKILL_ID}/override`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${await token()}` },
      },
    );
    expect(res.status).toBe(204);
    expect(emit).toHaveBeenCalledWith(
      'skillUpdated',
      expect.objectContaining({ action: 'delete', skillId: SKILL_ID }),
    );
  });

  it('404 when no override row to delete', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ ownerId: USER_ID }]);
    selectLimit.mockResolvedValueOnce([{ role: 'owner' }]);
    selectLimit.mockResolvedValueOnce([
      { id: SKILL_ID, name: 'forge-code', scope: 'global' },
    ]);
    deleteReturning.mockResolvedValueOnce([]);

    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/skills/${SKILL_ID}/override`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${await token()}` },
      },
    );
    expect(res.status).toBe(404);
    expect(emit).not.toHaveBeenCalled();
  });
});
