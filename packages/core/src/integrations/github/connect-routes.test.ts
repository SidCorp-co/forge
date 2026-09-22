/**
 * Who owns a project's GitHub App, and who may reach it afterwards.
 *
 * The App these routes mint is created FOR a project: named after it, bound to
 * it, and used by its runners. Owning it by whoever pressed Connect makes it
 * resolvable by that one person, and every other admin of the same project —
 * including the org's own owner — is answered `connection not found` by the
 * repositories route (ISS-1115 criterion 7, reproduced live at 1d1d63492).
 *
 * Two claims are asserted here and they are separate. The MINT: an org
 * project's App is owned by that org, and creating one is an org-admin act
 * refused by name when the caller is not one. The REACH: the repositories
 * route resolves a connection the project's own binding points at, whatever
 * principal owns it, because the route has already proved the caller is an
 * admin of that project.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const ORG_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_ORG_ID = '99999999-9999-4999-8999-999999999999';
const CONNECTION_ID = '66666666-6666-4666-8666-666666666666';
/** The second admin: the one the live 404 was reproduced as. */
const ADMIN_B = '77777777-7777-4777-8777-777777777777';
/** The individual who happened to press Connect first. */
const CLICKER_A = '88888888-8888-4888-8888-888888888888';

process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-abcdef';
process.env.APP_BASE_URL = 'http://localhost';
process.env.PUBLIC_API_BASE_URL = 'http://localhost';

const caller = { userId: ADMIN_B };

vi.mock('../../middleware/auth.js', () => ({
  requireAuth:
    () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', caller.userId);
      await next();
    },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

/** The project row the connect route reads. `orgId` is the whole subject. */
const projectRow = vi.hoisted(() => ({
  value: null as { slug: string; name: string; orgId: string | null } | null,
}));
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (projectRow.value ? [projectRow.value] : []) }) }),
    }),
  },
}));

const authz = vi.hoisted(() => ({
  loadOrgRole: vi.fn(async () => null as string | null),
  orgRoleAtLeast: (role: string | null, min: string) => {
    const rank: Record<string, number> = { member: 1, admin: 2, owner: 3 };
    return role !== null && (rank[role] ?? 0) >= (rank[min] ?? 0);
  },
}));
vi.mock('../../lib/authz.js', () => authz);

/**
 * route-helpers is stubbed rather than loaded: it pulls the adapter registry
 * and the websocket server in, neither of which this door touches. The three
 * error constructors are reproduced exactly — status and `cause.code` are what
 * the assertions below read, and what a browser branches on.
 */
const helpers = vi.hoisted(() => ({
  projectRole: 'admin' as 'admin' | 'member' | 'viewer' | null,
}));
vi.mock('../route-helpers.js', () => ({
  badRequest: (details: unknown) =>
    new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } }),
  forbidden: (message = 'forbidden') =>
    new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } }),
  notFound: (entity = 'integration') =>
    new HTTPException(404, { message: `${entity} not found`, cause: { code: 'NOT_FOUND' } }),
  assertVaultConfigured: () => {},
  assertProjectMember: async () => {
    if (!helpers.projectRole)
      throw new HTTPException(403, { message: 'forbidden', cause: { code: 'FORBIDDEN' } });
    return helpers.projectRole;
  },
  assertAdmin: (role: string) => {
    if (role !== 'admin')
      throw new HTTPException(403, { message: 'forbidden', cause: { code: 'FORBIDDEN' } });
  },
}));

const store = vi.hoisted(() => ({
  createBinding: vi.fn(async () => ({ id: 'binding-new' })),
  createConnection: vi.fn(async () => ({ id: CONNECTION_ID })),
  decryptConnectionSecrets: vi.fn(() => ({ appId: '42', privateKey: 'pk' })),
  listActiveBindingsForProjectProvider: vi.fn(async () => [] as unknown[]),
  listBindingsForProject: vi.fn(async () => [] as unknown[]),
  listConnectionsForPrincipalUser: vi.fn(async () => [] as unknown[]),
  updateBinding: vi.fn(async () => ({})),
}));
vi.mock('../store.js', () => store);

vi.mock('./repositories.js', () => ({
  listInstallationRepositories: vi.fn(async () => [
    { installationId: 159473037, account: 'SidCorp-co', owner: 'SidCorp-co', repo: 'forge', fullName: 'SidCorp-co/forge' },
  ]),
}));

const converted = vi.hoisted(() => ({
  convertManifestCode: vi.fn(async () => ({
    appId: '42',
    privateKey: 'pk',
    webhookSecret: 'whsec_x',
    slug: 'forge-test',
    htmlUrl: 'https://github.com/apps/forge-test',
  })),
}));
vi.mock('./connect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./connect.js')>()),
  convertManifestCode: converted.convertManifestCode,
}));

vi.mock('./install-resolve.js', () => ({ findBindingOwningInstallation: vi.fn(async () => null) }));

const { githubConnectRoutes, githubCallbackRoutes } = await import('./connect-routes.js');
const { signConnectState } = await import('./connect.js');
const { errorHandler } = await import('../../middleware/error.js');
const { requestId } = await import('../../middleware/request-id.js');

function app() {
  const built = new Hono<{ Variables: import('../../middleware/request-id.js').RequestIdVars }>();
  built.use('*', requestId());
  built.route('/api/projects', githubConnectRoutes);
  built.route('/api', githubCallbackRoutes);
  built.onError(errorHandler);
  return built;
}

/** A connection minted the old way: owned by the individual who clicked. */
const userOwnedConnection = {
  id: CONNECTION_ID,
  provider: 'github',
  ownerType: 'user',
  ownerId: CLICKER_A,
  active: true,
  secretsEnc: Buffer.from('x'),
};

function bindingOnProject(projectId: string, active = true) {
  return {
    binding: { id: 'binding-1', projectId, provider: 'github', active, config: {} },
    connection: userOwnedConnection,
  };
}

/**
 * The store narrows by project itself, so the stub does too — a test whose
 * stub hands back another project's row would pass against a resolver that
 * never asked which project it was for.
 */
function bindings(...rows: ReturnType<typeof bindingOnProject>[]) {
  store.listBindingsForProject.mockImplementation(async (projectId: string) =>
    rows.filter((r) => r.binding.projectId === projectId),
  );
}

const repositories = (connectionId = CONNECTION_ID, projectId = PROJECT_ID) =>
  app().request(
    `/api/projects/${projectId}/integrations/github/repositories?connectionId=${connectionId}`,
  );

beforeEach(() => {
  vi.clearAllMocks();
  caller.userId = ADMIN_B;
  helpers.projectRole = 'admin';
  projectRow.value = { slug: 'forge-dev', name: 'Forge', orgId: ORG_ID };
  authz.loadOrgRole.mockResolvedValue('admin');
  bindings();
  store.listConnectionsForPrincipalUser.mockResolvedValue([]);
  store.createConnection.mockResolvedValue({ id: CONNECTION_ID });
});

describe('GET /:projectId/integrations/github/repositories — who may reach the App', () => {
  it("answers a second project admin for a connection the project's binding points at", async () => {
    // The live reproduction: the row is owned by CLICKER_A, the caller is
    // ADMIN_B, and the binding on this project is what ties them together.
    bindings(bindingOnProject(PROJECT_ID));
    store.listConnectionsForPrincipalUser.mockResolvedValue([]);

    const res = await repositories();

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  it('reaches the App through a binding that is switched off, which is the state a repick starts from', async () => {
    bindings(bindingOnProject(PROJECT_ID, false));

    expect((await repositories()).status).toBe(200);
  });

  it('still answers for a connection the caller owns that no binding points at yet', async () => {
    // The create path lists repositories BEFORE any binding exists.
    bindings();
    store.listConnectionsForPrincipalUser.mockResolvedValue([
      { ...userOwnedConnection, ownerId: ADMIN_B },
    ]);

    expect((await repositories()).status).toBe(200);
  });

  it('refuses a connection that is neither bound to this project nor the caller\'s', async () => {
    bindings();
    store.listConnectionsForPrincipalUser.mockResolvedValue([]);

    const res = await repositories();

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
  });

  it('does not lend a connection bound to some other project', async () => {
    bindings(bindingOnProject(OTHER_PROJECT_ID));

    expect((await repositories()).status).toBe(404);
  });

  it('refuses a caller who is a project member but not an admin, before any lookup', async () => {
    helpers.projectRole = 'member';
    bindings(bindingOnProject(PROJECT_ID));

    expect((await repositories()).status).toBe(403);
    expect(store.listBindingsForProject).not.toHaveBeenCalled();
  });

  it('refuses a request with no connectionId by naming the field', async () => {
    const res = await app().request(
      `/api/projects/${PROJECT_ID}/integrations/github/repositories`,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).details).toEqual({ connectionId: 'required' });
  });

  it('refuses a bound App that was never converted, rather than calling GitHub with no key', async () => {
    bindings(bindingOnProject(PROJECT_ID));
    store.decryptConnectionSecrets.mockReturnValue({});

    const res = await repositories();

    expect(res.status).toBe(400);
    expect((await res.json()).details).toEqual({ connectionId: 'the App was never converted' });
  });
});

describe('POST /:projectId/integrations/github/connect — who the App will belong to', () => {
  const connect = (query = '') =>
    app().request(`/api/projects/${PROJECT_ID}/integrations/github/connect${query}`, {
      method: 'POST',
    });

  function ownerOfSignedState(body: { state: string }) {
    const [payload] = body.state.split('.');
    return JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      projectId: string;
      userId: string;
      orgId?: string;
    };
  }

  it("names the project's own org as the owner, so every admin of it resolves the App", async () => {
    const res = await connect();

    expect(res.status).toBe(200);
    expect(ownerOfSignedState(await res.json()).orgId).toBe(ORG_ID);
  });

  it('refuses a project admin who is not an org admin, naming the org and the way round', async () => {
    authz.loadOrgRole.mockResolvedValue('member');

    const res = await connect();
    const body = await res.json();

    expect(res.status).toBe(403);
    // Its own code keeps the sentence: the web prints one generic line for
    // FORBIDDEN and drops the server's message.
    expect(body.code).toBe('ORG_ADMIN_REQUIRED');
    expect(body.message).toContain(ORG_ID);
    expect(body.message).toMatch(/org admin/i);
  });

  it('leaves a project that belongs to no org owned by the operator, which is the only principal there is', async () => {
    projectRow.value = { slug: 'solo', name: 'Solo', orgId: null };

    const res = await connect();

    expect(ownerOfSignedState(await res.json()).orgId).toBeUndefined();
  });

  it("refuses an orgId query that is not the project's own org", async () => {
    const res = await connect(`?orgId=${OTHER_ORG_ID}`);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ORG_MISMATCH');
  });

  it('accepts an orgId query that agrees with the project', async () => {
    const res = await connect(`?orgId=${ORG_ID}`);

    expect(res.status).toBe(200);
    expect(ownerOfSignedState(await res.json()).orgId).toBe(ORG_ID);
  });

  it('answers 404 for a project that does not exist', async () => {
    projectRow.value = null;

    expect((await connect()).status).toBe(404);
  });
});

describe('GET /integrations/github/manifest-callback — what the mint writes', () => {
  const callback = (state: string) =>
    app().request(`/api/integrations/github/manifest-callback?code=abc&state=${state}`);

  it('mints the connection against the org the connect flow named', async () => {
    const state = signConnectState(process.env.JWT_SECRET as string, {
      projectId: PROJECT_ID,
      userId: ADMIN_B,
      orgId: ORG_ID,
    });

    await callback(state);

    expect(store.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ ownerType: 'org', ownerId: ORG_ID }),
    );
  });

  it('mints against the operator where the connect flow named no org', async () => {
    const state = signConnectState(process.env.JWT_SECRET as string, {
      projectId: PROJECT_ID,
      userId: ADMIN_B,
    });

    await callback(state);

    expect(store.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ ownerType: 'user', ownerId: ADMIN_B }),
    );
  });

  it('creates nothing for a state issued to another user', async () => {
    const state = signConnectState(process.env.JWT_SECRET as string, {
      projectId: PROJECT_ID,
      userId: CLICKER_A,
      orgId: ORG_ID,
    });

    expect((await callback(state)).status).toBe(400);
    expect(converted.convertManifestCode).not.toHaveBeenCalled();
    expect(store.createConnection).not.toHaveBeenCalled();
  });
});
