/**
 * ISS-40 PR-E — dependency route authz. The edge write itself moved to
 * `dependency-service.ts` (ISS-889) and is tested there; what is left here is
 * the part this file owns, which is who the routes let through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbSelect = vi.fn();

vi.mock('./issue-prefix-read.js', () => ({
  activeIssuePrefix: async () => null,
  heldIssuePrefixes: async () => [],
}));
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

vi.mock('./decompose.js', () => ({ decomposeParent: vi.fn(async () => {}) }));
vi.mock('./pipeline-health.js', () => ({
  publishPipelineHealthChanged: vi.fn(async () => {}),
  hydratePipelineHealthForIssues: vi.fn(async () => new Map()),
}));
vi.mock('../pipeline/activity.js', () => ({
  safeRecordActivity: vi.fn(async () => {}),
  recordActivityTx: vi.fn(async () => {}),
}));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
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

/**
 * ISS-1160 — this route sits behind the shared `resolveIssueRouteRef` door, so
 * a display key (`ISS-1097`) reaches the same edges a uuid does, scoped to a
 * project the caller names and can read, and every unresolvable shape is
 * refused by name rather than answered with the generic uuid-shape 400 this
 * issue reported.
 */
describe('dependency route identifier resolution (ISS-1160)', () => {
  const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
  const ISSUE_ID = '11111111-1111-4111-8111-111111111111';

  async function getKey(path: string) {
    const { Hono } = await import('hono');
    const { issueDependencyRoutes } = await import('./dependency-routes.js');
    const { errorHandler } = await import('../middleware/error.js');
    const app = new Hono();
    app.route('/api/issues', issueDependencyRoutes);
    app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
    return app.request(`/api/issues/${path}`);
  }

  beforeEach(() => {
    projectAccess.mockReset();
    dbSelect.mockReset();
  });

  it('refuses a display key with no project to scope it — 400, naming what is missing', async () => {
    const res = await getKey('ISS-1097/dependencies');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/Invalid input/);
  });

  it('refuses a string that is neither a uuid nor a display key, with an example of each', async () => {
    const res = await getKey('not-an-issue/dependencies');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { details?: { formErrors?: string[] } };
    const formErrors = body.details?.formErrors ?? [];
    expect(formErrors.join(' ')).toMatch(/ISS-42/);
  });

  it('refuses a project the caller cannot read — 403, before any key is looked up in it', async () => {
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: null,
      orgRole: null,
    });
    const res = await getKey(`ISS-1097/dependencies?projectId=${PROJECT_ID}`);
    expect(res.status).toBe(403);
  });

  it('answers 404 naming the key when the project holds no issue at that number', async () => {
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: 'member',
      orgRole: null,
    });
    dbSelect.mockImplementationOnce(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }));
    const res = await getKey(`ISS-1097/dependencies?projectId=${PROJECT_ID}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/ISS-1097/);
  });

  it('resolves the same row as the uuid, scoped to the named project', async () => {
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: 'member',
      orgRole: null,
    });
    dbSelect.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ id: ISSUE_ID, projectId: PROJECT_ID }]) }),
      }),
    }));
    dbSelect.mockImplementation(() => ({
      from: () => ({
        leftJoin: () => ({ leftJoin: () => ({ where: () => Promise.resolve([]) }) }),
      }),
    }));
    const res = await getKey(`ISS-1097/dependencies?projectId=${PROJECT_ID}`);
    expect(res.status).toBe(200);
  });
});
