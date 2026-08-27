/**
 * ISS-40 PR-E — dependency-routes cycle detection unit tests. The route
 * handlers themselves are integration-tested at the platform level; here
 * we focus on `detectCycle` since it's the load-bearing safety check.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbSelect = vi.fn();

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../pipeline/hooks.js', () => ({
  hooks: { emit: vi.fn(async () => {}) },
}));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const { detectCycle } = await import('./dependency-routes.js');

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('detectCycle', () => {
  it('returns "cycle" for a self-edge target', async () => {
    expect(await detectCycle('project', 'A', 'A')).toBe('cycle');
  });

  it('returns null when the graph is empty', async () => {
    // every db.select returns no children
    dbSelect.mockImplementation(() => ({
      from: () => ({ where: () => Promise.resolve([]) }),
    }));
    expect(await detectCycle('project', 'B', 'A')).toBeNull();
  });

  it('returns "cycle" when DFS reaches the target', async () => {
    // graph: B -> A. Calling detectCycle('B','A') walks from B and
    // immediately finds A as a child.
    dbSelect.mockImplementationOnce(() => ({
      from: () => ({ where: () => Promise.resolve([{ to: 'A' }]) }),
    }));
    expect(await detectCycle('project', 'B', 'A')).toBe('cycle');
  });

  it('returns null when DFS exhausts without reaching target', async () => {
    // B -> C, C -> D (no edge to A)
    dbSelect
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => Promise.resolve([{ to: 'C' }]) }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => Promise.resolve([{ to: 'D' }]) }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => Promise.resolve([]) }),
      }));
    expect(await detectCycle('project', 'B', 'A')).toBeNull();
  });
});

/**
 * The authz regression. Until 2026-08-23 all three verbs read `project_members`
 * directly, so an org admin — who holds project `admin` on every project their
 * org owns WITHOUT a membership row — got 403 on every one. Measured on
 * forge-beta: 50 failed requests per Issues-page load, for the org's own admin.
 */
describe('dependency route authz', () => {
  const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
  const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

  async function get() {
    const { Hono } = await import('hono');
    const { issueDependencyRoutes } = await import('./dependency-routes.js');
    const app = new Hono();
    app.route('/api/issues', issueDependencyRoutes);
    return app.request(`/api/issues/${ISSUE_ID}/dependencies`);
  }

  beforeEach(() => {
    projectAccess.mockReset();
    dbSelect.mockReset();
  });

  it('admits an org admin who has no project_members row', async () => {
    dbSelect.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ projectId: PROJECT_ID }]) }),
      }),
    }));
    // cm:why role comes from the ORG with no membership row — the exact shape the old raw-row lookup 403'd, and the only shape that distinguishes this fix from the code it replaced.
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: 'admin',
      orgRole: 'admin',
    });
    const edges = () => ({
      from: () => ({
        leftJoin: () => ({ leftJoin: () => ({ where: () => Promise.resolve([]) }) }),
      }),
    });
    dbSelect.mockImplementation(edges);

    const res = await get();
    expect(res.status).toBe(200);
    expect(projectAccess).toHaveBeenCalledWith(PROJECT_ID, undefined);
  });

  it('still refuses a caller with no effective role at all', async () => {
    dbSelect.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ projectId: PROJECT_ID }]) }),
      }),
    }));
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: null,
      orgRole: null,
    });

    const res = await get();
    expect(res.status).toBe(403);
  });
});
