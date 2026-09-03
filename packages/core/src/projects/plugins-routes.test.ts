// The plugins endpoint, in its own file because `routes.test.ts` sits at a
// frozen size budget and this block would have pushed it over. Its mock
// harness is deliberately the NARROW one the endpoint actually reaches — an
// auth read, the project row, and the update — rather than a copy of the
// monolith's chain next door.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn((): unknown => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

const updateWhere = vi.fn(async () => undefined);
const updateSet = vi.fn((..._args: unknown[]) => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    selectDistinctOn: vi.fn(() => ({ from: vi.fn() })),
    transaction: vi.fn(),
    update: dbUpdate,
    delete: vi.fn(),
    insert: vi.fn(),
  },
}));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
  loadPersonalOrgId: vi.fn(),
}));

const { projectRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

const ORG_ID = '99999999-9999-4999-8999-999999999999';
type OrgRole = 'owner' | 'admin' | 'member' | null;
const access = (orgRole: OrgRole) => ({
  projectId: 'p1',
  orgId: ORG_ID,
  role: 'admin' as const,
  orgRole,
});

function req(path: string, opts: { method: string; body: string; token: string }) {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', projectRoutes);
  app.onError(errorHandler);
  return app.request(`/api/projects${path}`, {
    method: opts.method,
    headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
    body: opts.body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
});

describe('PATCH /api/projects/:id/plugins (ISS-897)', () => {
  const PID = '11111111-1111-4111-8111-111111111111';
  const PLUGIN = {
    marketplace: 'SidCorp-co/forge-plugin',
    name: 'forge',
    pinnedRef: null,
    autoUpdate: true,
  };

  function seed(agentConfig: Record<string, unknown>, orgRole: OrgRole = 'admin') {
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access(orgRole));
    selectLimit.mockResolvedValueOnce([{ agentConfig }]);
  }

  function patch(token: string, body: unknown) {
    return req(`/${PID}/plugins`, { method: 'PATCH', body: JSON.stringify(body), token });
  }

  // cm:guard the write REPLACES `plugins` and must leave every sibling key of `agentConfig` alone. This is the ISS-767 pattern: a scoped patch that writes the whole blob back is one omitted spread away from wiping `pipelineConfig`, and nothing else in the product would notice until a dispatch.
  it('replaces the list and preserves every sibling key of agentConfig', async () => {
    const token = await signUserToken('uuid-owner');
    seed({
      pipelineConfig: { enabled: true },
      repoPath: '/repo',
      plugins: [{ ...PLUGIN, name: 'old' }],
    });

    const res = await patch(token, { plugins: [PLUGIN] });

    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({
      agentConfig: { pipelineConfig: { enabled: true }, repoPath: '/repo', plugins: [PLUGIN] },
    });
  });

  // cm:guard `null` DELETES the key rather than writing `plugins: null` — `GET /api/devices/me/plugins` unions this list across projects, and a null entry there is a shape its reader does not have.
  it('deletes the key on null rather than writing a null value', async () => {
    const token = await signUserToken('uuid-owner');
    seed({ repoPath: '/repo', plugins: [PLUGIN] });

    const res = await patch(token, { plugins: null });

    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({ agentConfig: { repoPath: '/repo' } });
  });

  it('accepts an empty list, which is a project that designates nothing', async () => {
    const token = await signUserToken('uuid-owner');
    seed({ plugins: [PLUGIN] });

    expect((await patch(token, { plugins: [] })).status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({ agentConfig: { plugins: [] } });
  });

  // cm:guard the shape is validated SERVER-side, not only in the form. A device resolves what it installs from this list, so a malformed name or a ref that is not a SHA reaches a box that then fails to install with no operator anywhere near it.
  it('400s on a malformed entry, before any write', async () => {
    for (const bad of [
      { marketplace: '', name: 'forge', pinnedRef: null },
      { marketplace: 'a/b', name: 'Forge Plugin', pinnedRef: null },
      { marketplace: 'a/b', name: 'forge', pinnedRef: 'not-a-sha' },
    ]) {
      const token = await signUserToken('uuid-owner');
      selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

      const res = await patch(token, { plugins: [bad] });

      expect(res.status).toBe(400);
    }
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('403s a project admin who is not an org admin', async () => {
    const token = await signUserToken('uuid-owner');
    seed({ plugins: [] }, null);

    expect((await patch(token, { plugins: [PLUGIN] })).status).toBe(403);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('404s when the project row is gone', async () => {
    const token = await signUserToken('uuid-owner');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    projectAccess.mockResolvedValueOnce(access('admin'));
    selectLimit.mockResolvedValueOnce([]);

    expect((await patch(token, { plugins: [PLUGIN] })).status).toBe(404);
    expect(updateSet).not.toHaveBeenCalled();
  });
});
