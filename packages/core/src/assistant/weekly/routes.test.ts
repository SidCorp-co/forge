/**
 * ISS-1056 — the run-now door: org admin or owner only, refuses by name a project whose config
 * is off, and returns the runner's outcome for the one project.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: selectLimit })) })),
    })),
    selectDistinctOn: vi.fn(),
    transaction: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    insert: vi.fn(),
  },
}));

const projectAccess = vi.fn();
vi.mock('../../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
  loadPersonalOrgId: vi.fn(),
}));

const runForProject = vi.fn();
vi.mock('./run.js', () => ({
  realDeps: () => ({ tag: 'real' }),
  runAssistantWeeklyForProject: (...args: unknown[]) => runForProject(...args),
}));

const { assistantWeeklyRoutes } = await import('./routes.js');
const { signUserToken } = await import('../../auth/jwt.js');
const { errorHandler } = await import('../../middleware/error.js');
const { requestId } = await import('../../middleware/request-id.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '99999999-9999-4999-8999-999999999999';
const access = (orgRole: 'owner' | 'admin' | 'member' | null) => ({
  projectId: PROJECT_ID,
  orgId: ORG_ID,
  role: 'admin' as const,
  orgRole,
});
const on = {
  enabled: true,
  pinnedIssue: 'ISS-9',
  judgeProviderId: 'litellm',
  judgeModel: 'judge-x',
};
const projectRow = (assistantWeekly: unknown) => ({
  id: PROJECT_ID,
  slug: 'qa',
  createdBy: 'owner-1',
  agentConfig: { pipelineConfig: { assistantWeekly } },
});

async function run(orgRole: 'owner' | 'admin' | 'member' | null) {
  const app = new Hono<{ Variables: import('../../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', assistantWeeklyRoutes);
  app.onError(errorHandler);
  projectAccess.mockResolvedValue(access(orgRole));
  const token = await signUserToken('u1');
  return app.request(`/api/projects/${PROJECT_ID}/assistant-weekly/run`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  // the router's own assertEmailVerified reads the user row first, then the handler reads the project
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
});

describe('POST /api/projects/:id/assistant-weekly/run (ISS-1056)', () => {
  it('runs the one project with the real deps and returns the outcome', async () => {
    selectLimit.mockResolvedValueOnce([projectRow(on)]);
    runForProject.mockResolvedValue({ outcome: 'posted', windowId: '2026-09-07..2026-09-14' });
    const res = await run('admin');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'posted', windowId: '2026-09-07..2026-09-14' });
    const [project, deps] = runForProject.mock.calls[0] ?? [];
    expect(project).toEqual({
      projectId: PROJECT_ID,
      slug: 'qa',
      createdBy: 'owner-1',
      config: { pinnedIssue: 'ISS-9', judgeProviderId: 'litellm', judgeModel: 'judge-x' },
    });
    expect(deps).toEqual({ tag: 'real' });
  });

  it('refuses an org member: the reading posts as the project and reads its whole week', async () => {
    const res = await run('member');
    expect(res.status).toBe(403);
    expect(runForProject).not.toHaveBeenCalled();
  });

  it('refuses by name a project whose assistantWeekly is off or absent', async () => {
    selectLimit.mockResolvedValueOnce([projectRow({ ...on, enabled: false })]);
    const res = await run('owner');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { message?: string }; message?: string };
    expect(JSON.stringify(body)).toContain('assistantWeekly is not enabled');
    expect(runForProject).not.toHaveBeenCalled();
  });
});
