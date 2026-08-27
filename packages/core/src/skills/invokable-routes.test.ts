// ISS-718 — `GET /api/skills/invokable`, the source the chat composer's slash
// menu reads. Its own file because crud-routes.test.ts is frozen at its current
// length in .forge/size-baseline.json. What matters: only install_only skills
// are offered (the menu must not name a skill POST /agent-sessions/start would
// then reject), non-members get nothing, and the literal path is not swallowed
// by the sibling `GET /:id` uuid route.
//
// The db stub routes loadProjectAccess's select().from().leftJoin().leftJoin()
// .where().limit() chain back into one where/limit FIFO, so each `mockResolved`
// below is consumed in call order.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectOrderBy = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectLeftJoin = vi.fn(
  (): Record<string, unknown> => ({ leftJoin: selectLeftJoin, where: selectWhere }),
);
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

const resolveRegisteredEffectiveSkills = vi.fn();
vi.mock('./effective.js', async () => {
  const actual = await vi.importActual<typeof import('./effective.js')>('./effective.js');
  return {
    ...actual,
    resolveRegisteredEffectiveSkills: (projectId: string) =>
      resolveRegisteredEffectiveSkills(projectId),
  };
});

vi.mock('../jobs/enqueue.js', () => ({ enqueueJob: vi.fn(async () => undefined) }));

const { skillCrudRoutes } = await import('./crud-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/skills', skillCrudRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

/** One effective-skill row, only the fields the route projects. */
function skill(name: string, installOnly: boolean, description = `does ${name}`) {
  return { skillId: `id-${name}`, name, description, installOnly };
}

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

/** loadProjectAccess → a member of the project. */
function accessAsMember() {
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: 'member' }]);
}

/** loadProjectAccess → no role at all (not a member). */
function accessAsOutsider() {
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: null }]);
}

async function get(path: string) {
  return buildApp().request(path, {
    headers: { authorization: `Bearer ${await signUserToken(USER_ID)}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderBy.mockReset();
  resolveRegisteredEffectiveSkills.mockReset();
});

describe('GET /api/skills/invokable', () => {
  it('returns only install_only skills, name-sorted, as name + description', async () => {
    authVerified();
    accessAsMember();
    resolveRegisteredEffectiveSkills.mockResolvedValueOnce([
      skill('forge-review', false),
      skill('zeta-util', true, 'last alphabetically'),
      skill('forge-code', false),
      skill('Bad_Name', true),
      skill('1tool', true),
      skill('tool/name', true),
      skill('alpha-util', true, 'first alphabetically'),
    ]);

    const res = await get(`/api/skills/invokable?projectId=${PROJECT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: Array<{ name: string; description: string }> };
    expect(body.skills).toEqual([
      { name: 'alpha-util', description: 'first alphabetically' },
      { name: 'zeta-util', description: 'last alphabetically' },
    ]);
    expect(resolveRegisteredEffectiveSkills).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('returns an empty list (not a 404) when the project has no install_only skills', async () => {
    authVerified();
    accessAsMember();
    resolveRegisteredEffectiveSkills.mockResolvedValueOnce([skill('forge-code', false)]);

    const res = await get(`/api/skills/invokable?projectId=${PROJECT_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skills: [] });
  });

  it('403s a non-member and never reads the project s skills', async () => {
    authVerified();
    accessAsOutsider();

    const res = await get(`/api/skills/invokable?projectId=${PROJECT_ID}`);
    expect(res.status).toBe(403);
    expect(resolveRegisteredEffectiveSkills).not.toHaveBeenCalled();
  });

  it('400s without a projectId — the list is meaningless project-wide', async () => {
    authVerified();
    const res = await get('/api/skills/invokable');
    expect(res.status).toBe(400);
    expect(resolveRegisteredEffectiveSkills).not.toHaveBeenCalled();
  });

  // cm:why registered after `GET /:id`, the literal path parses as an id and that route's uuid validator answers 400 before this handler ever runs
  it('is not swallowed by the sibling GET /:id uuid route', async () => {
    authVerified();
    accessAsMember();
    resolveRegisteredEffectiveSkills.mockResolvedValueOnce([skill('only-one', true)]);

    const res = await get(`/api/skills/invokable?projectId=${PROJECT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: Array<{ name: string }> };
    expect(body.skills.map((s) => s.name)).toEqual(['only-one']);
  });
});
