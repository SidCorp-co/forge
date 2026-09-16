// ISS-1038 — the read is member-wide, the write is org-admin, and the write
// refuses a provider that injects nothing by name.
//
// The split is the point. The defect this issue was filed on is an operator
// looking at a green integration panel that reaches no agent and finding no
// screen that says why; a truth surface only an admin could load would leave
// most of that standing. So: everyone reads, and `canEdit` on the response is
// what the control's enabled state comes from — the server is the only party
// that knows the caller's org role, and a client-side guess can disagree with
// what the PUT will accept.

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const access = {
  value: null as null | {
    projectId: string;
    orgId: string;
    role: 'admin' | 'member' | 'viewer' | null;
    orgRole: 'owner' | 'admin' | 'member' | null;
  },
};

const ORG_ORDER = ['member', 'admin', 'owner'];

vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: async () => {
    if (!access.value) throw new Error('test did not set access');
    return access.value;
  },
  orgRoleAtLeast: (role: string | null, min: string) =>
    role !== null && ORG_ORDER.indexOf(role) >= ORG_ORDER.indexOf(min),
  assertOrgRoleOnProject: (a: { orgRole: string | null }, min: string, message?: string) => {
    if (a.orgRole === null || ORG_ORDER.indexOf(a.orgRole) < ORG_ORDER.indexOf(min)) {
      throw new HTTPException(403, {
        message: message ?? 'forbidden',
        cause: { code: 'FORBIDDEN' },
      });
    }
  },
}));

const flagOn = { value: true };
vi.mock('../lib/feature-flags.js', () => ({
  isEnabled: (flag: string) => (flag === 'pipelineControl' ? flagOn.value : false),
}));

vi.mock('./route-helpers.js', () => ({
  badRequest: (details: unknown) =>
    new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } }),
  forbidden: () => new HTTPException(403, { message: 'forbidden', cause: { code: 'FORBIDDEN' } }),
}));

const injectionState = vi.fn(async () => [
  {
    provider: 'epodsystem' as const,
    declaredDefault: true,
    declaredStates: ['testing'],
    excludedStates: [],
    configured: true,
  },
]);
const setMcpServerSentinel = vi.fn(async (_input: unknown) => ({
  pipelineConfig: {},
  warnings: [] as string[],
}));

vi.mock('./mcp-injection-service.js', () => ({
  MCP_INJECTION_PROVIDERS: ['postman', 'epodsystem', 'sentry'] as const,
  isMcpInjectionProvider: (v: string) => ['postman', 'epodsystem', 'sentry'].includes(v),
  buildMcpInjectionState: () => injectionState(),
}));

vi.mock('../pipeline/pipeline-config-service.js', () => ({
  setMcpServerSentinel: (input: unknown) => setMcpServerSentinel(input),
}));

vi.mock('../projects/pipeline-config-http.js', () => ({
  pipelineConfigHttpError: (err: unknown) => err,
}));

const { mcpInjectionRoutes } = await import('./mcp-injection-routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

type TestVars = { Variables: import('../middleware/request-id.js').RequestIdVars };

function buildApp() {
  const app = new Hono<TestVars>();
  app.use('*', requestId());
  app.use('*', async (c, next) => {
    // The real router sets this in `requireAuth()`, which is mounted a level up
    // on `integrationsRoutes` rather than here.
    (c as unknown as { set: (k: string, v: string) => void }).set('userId', 'u-1');
    await next();
  });
  app.route('/api/projects', mcpInjectionRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT = '11111111-1111-4111-8111-111111111111';
const GET_PATH = `/api/projects/${PROJECT}/integrations/mcp-injection`;

function asOrg(
  orgRole: 'owner' | 'admin' | 'member' | null,
  role: 'admin' | 'member' | null = 'member',
) {
  access.value = { projectId: PROJECT, orgId: 'o-1', role, orgRole };
}

beforeEach(() => {
  access.value = null;
  flagOn.value = true;
  injectionState.mockClear();
  setMcpServerSentinel.mockClear();
});

describe('GET mcp-injection (ISS-1038)', () => {
  it('serves an org admin the state with canEdit true', async () => {
    asOrg('admin', 'admin');
    const res = await buildApp().request(GET_PATH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: unknown[]; canEdit: boolean };
    expect(body.canEdit).toBe(true);
    expect(body.providers).toHaveLength(1);
  });

  it('serves a plain project member the SAME state with canEdit false', async () => {
    asOrg('member', 'member');
    const res = await buildApp().request(GET_PATH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: unknown[]; canEdit: boolean };
    expect(body.canEdit).toBe(false);
    // Not an empty or redacted answer — the same rows. A member who cannot
    // change it must still be able to see why an integration reaches nothing.
    expect(body.providers).toHaveLength(1);
  });

  it('reports canEdit false to an org admin when the pipeline surface is off', async () => {
    asOrg('admin', 'admin');
    flagOn.value = false;
    const res = await buildApp().request(GET_PATH);
    const body = (await res.json()) as { canEdit: boolean };
    expect(body.canEdit).toBe(false);
  });

  it('refuses someone with no role on the project', async () => {
    asOrg(null, null);
    const res = await buildApp().request(GET_PATH);
    expect(res.status).toBe(403);
  });
});

describe('PUT mcp-injection/:provider (ISS-1038)', () => {
  function put(provider: string, body: unknown, method = 'PUT') {
    return buildApp().request(`/api/projects/${PROJECT}/integrations/mcp-injection/${provider}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('writes the sentinel for an org admin and answers with the fresh state', async () => {
    asOrg('admin', 'admin');
    const res = await put('epodsystem', { enabled: true });
    expect(res.status).toBe(200);
    expect(setMcpServerSentinel).toHaveBeenCalledWith({
      projectId: PROJECT,
      name: 'epodsystem',
      enabled: true,
    });
    const body = (await res.json()) as { canEdit: boolean };
    expect(body.canEdit).toBe(true);
  });

  it('writes for every provider the dispatcher resolves, not only epodsystem', async () => {
    for (const provider of ['postman', 'epodsystem', 'sentry']) {
      asOrg('admin', 'admin');
      setMcpServerSentinel.mockClear();
      const res = await put(provider, { enabled: true });
      expect(res.status).toBe(200);
      expect(setMcpServerSentinel).toHaveBeenCalledWith({
        projectId: PROJECT,
        name: provider,
        enabled: true,
      });
    }
  });

  it('removes the key when disabling', async () => {
    asOrg('owner', 'admin');
    const res = await put('sentry', { enabled: false });
    expect(res.status).toBe(200);
    expect(setMcpServerSentinel).toHaveBeenCalledWith({
      projectId: PROJECT,
      name: 'sentry',
      enabled: false,
    });
  });

  it('refuses a project member below org admin, and writes nothing', async () => {
    asOrg('member', 'admin');
    const res = await put('epodsystem', { enabled: true });
    expect(res.status).toBe(403);
    expect(setMcpServerSentinel).not.toHaveBeenCalled();
  });

  it('refuses an unknown provider BY NAME, and writes nothing', async () => {
    asOrg('admin', 'admin');
    const res = await put('rocketchat', { enabled: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string }; message?: string };
    const message = body.error?.message ?? body.message ?? JSON.stringify(body);
    // The refusal is the deliverable: it names what was wrong and what is
    // valid, rather than storing a sentinel the dispatcher would sweep away.
    expect(message).toContain('rocketchat');
    expect(message).toContain('postman');
    expect(setMcpServerSentinel).not.toHaveBeenCalled();
  });

  it('refuses a body that is not { enabled: boolean }', async () => {
    asOrg('admin', 'admin');
    const res = await put('epodsystem', { enabled: 'yes' });
    expect(res.status).toBe(400);
    expect(setMcpServerSentinel).not.toHaveBeenCalled();
  });

  it('is 404 when the pipeline surface is switched off', async () => {
    asOrg('admin', 'admin');
    flagOn.value = false;
    const res = await put('epodsystem', { enabled: true });
    expect(res.status).toBe(404);
    expect(setMcpServerSentinel).not.toHaveBeenCalled();
  });
});
