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
  value: null as {
    slug: string;
    name: string;
    orgId: string;
    orgIsPersonal: boolean;
  } | null,
}));
vi.mock('../../db/client.js', () => {
  const rows = async () => (projectRow.value ? [projectRow.value] : []);
  const where = () => ({ limit: rows });
  return {
    db: { select: () => ({ from: () => ({ innerJoin: () => ({ where }), where }) }) },
  };
});

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
  connectionNotReachable: (id: string) =>
    new HTTPException(404, {
      message: `connection ${id} is not one you can reach.`,
      cause: { code: 'CONNECTION_NOT_REACHABLE' },
    }),
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
  decryptConnectionSecrets: vi.fn((): { appId?: string; privateKey?: string } => ({
    appId: '42',
    privateKey: 'pk',
  })),
  listActiveBindingsForProjectProvider: vi.fn(async () => [] as unknown[]),
  updateBinding: vi.fn(async () => ({})),
}));
vi.mock('../store.js', () => store);

/**
 * The reach rule is `../reach.ts`'s, tested against real rows in
 * `tests/integration/connection-reach-e2e.test.ts`. What this door owes is what it does with the
 * answer: resolve the App, refuse by name, or refuse a provider that has no repositories.
 */
const reach = vi.hoisted(() => ({
  findReachableConnection: vi.fn(async (_userId: string, _connectionId: string) => null as unknown),
}));
vi.mock('../reach.js', () => reach);

vi.mock('./repositories.js', () => ({
  listInstallationRepositories: vi.fn(async () => [
    {
      installationId: 159473037,
      account: 'SidCorp-co',
      owner: 'SidCorp-co',
      repo: 'forge',
      fullName: 'SidCorp-co/forge',
    },
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

/** What the reach rule answers for a connection the caller reaches. */
function reaches(connection: Record<string, unknown> = userOwnedConnection) {
  reach.findReachableConnection.mockResolvedValue({
    connection,
    reach: 'binding',
    canManage: false,
    viaProjectIds: [PROJECT_ID],
  });
}

/** Every refusal on these routes answers in this shape. */
type Body = { code: string; message: string; details?: unknown; state?: string };
const bodyOf = async (res: Response) => (await res.json()) as Body;

const repositories = (connectionId = CONNECTION_ID, projectId = PROJECT_ID) =>
  app().request(
    `/api/projects/${projectId}/integrations/github/repositories?connectionId=${connectionId}`,
  );

beforeEach(() => {
  vi.clearAllMocks();
  caller.userId = ADMIN_B;
  helpers.projectRole = 'admin';
  projectRow.value = { slug: 'forge-dev', name: 'Forge', orgId: ORG_ID, orgIsPersonal: false };
  authz.loadOrgRole.mockResolvedValue('admin');
  reach.findReachableConnection.mockResolvedValue(null);
  store.createConnection.mockResolvedValue({ id: CONNECTION_ID });
});

describe('GET /:projectId/integrations/github/repositories — what the door does with the reach answer', () => {
  it('lists the repositories of an App the caller reaches, whoever owns it', async () => {
    // The live reproduction: the row is owned by CLICKER_A, the caller is ADMIN_B.
    reaches();

    const res = await repositories();

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
    expect(reach.findReachableConnection).toHaveBeenCalledWith(ADMIN_B, CONNECTION_ID);
  });

  it('refuses a connection the caller does not reach, naming it', async () => {
    const res = await repositories();
    const body = await bodyOf(res);

    expect(res.status).toBe(404);
    expect(body.code).toBe('CONNECTION_NOT_REACHABLE');
    expect(body.message).toContain(CONNECTION_ID);
  });

  it('refuses a reached connection that is not a GitHub App, by naming the field', async () => {
    reaches({ ...userOwnedConnection, provider: 'coolify' });

    const res = await repositories();

    expect(res.status).toBe(400);
    expect((await bodyOf(res)).details).toEqual({
      connectionId: 'is not a GitHub App, so it has no repositories to list',
    });
  });

  it('refuses a caller who is a project member but not an admin, before any lookup', async () => {
    helpers.projectRole = 'member';
    reaches();

    expect((await repositories()).status).toBe(403);
    expect(reach.findReachableConnection).not.toHaveBeenCalled();
  });

  it('refuses a request with no connectionId by naming the field', async () => {
    const res = await app().request(`/api/projects/${PROJECT_ID}/integrations/github/repositories`);

    expect(res.status).toBe(400);
    expect((await bodyOf(res)).details).toEqual({ connectionId: 'required' });
  });

  it('refuses a bound App that was never converted, rather than calling GitHub with no key', async () => {
    reaches();
    store.decryptConnectionSecrets.mockReturnValue({});

    const res = await repositories();

    expect(res.status).toBe(400);
    expect((await bodyOf(res)).details).toEqual({
      connectionId: 'the App was never converted',
    });
  });
});

describe('POST /:projectId/integrations/github/connect — who the App will belong to', () => {
  const connect = (query = '') =>
    app().request(`/api/projects/${PROJECT_ID}/integrations/github/connect${query}`, {
      method: 'POST',
    });

  function ownerOfSignedState(body: Body) {
    const payload = (body.state ?? '').split('.')[0] ?? '';
    return JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      projectId: string;
      userId: string;
      orgId?: string;
    };
  }

  it("names the project's own org as the owner, so every admin of it resolves the App", async () => {
    const res = await connect();

    expect(res.status).toBe(200);
    expect(ownerOfSignedState(await bodyOf(res)).orgId).toBe(ORG_ID);
  });

  it('refuses a project admin who is not an org admin, naming the org and the way round', async () => {
    authz.loadOrgRole.mockResolvedValue('member');

    const res = await connect();
    const body = await bodyOf(res);

    expect(res.status).toBe(403);
    // Its own code keeps the sentence: the web prints one generic line for
    // FORBIDDEN and drops the server's message.
    expect(body.code).toBe('ORG_ADMIN_REQUIRED');
    expect(body.message).toContain(ORG_ID);
    expect(body.message).toMatch(/org admin/i);
  });

  it("leaves a solo operator's App theirs, because a personal org is not a second principal", async () => {
    // The connections directory scopes a personal org to ownerType 'user', so
    // an App owned by that org would be invisible to its only admin.
    projectRow.value = { slug: 'solo', name: 'Solo', orgId: ORG_ID, orgIsPersonal: true };

    const res = await connect();

    expect(res.status).toBe(200);
    expect(ownerOfSignedState(await bodyOf(res)).orgId).toBeUndefined();
  });

  it('does not ask a solo operator for org admin they could not have', async () => {
    projectRow.value = { slug: 'solo', name: 'Solo', orgId: ORG_ID, orgIsPersonal: true };
    authz.loadOrgRole.mockResolvedValue('member');

    expect((await connect()).status).toBe(200);
  });

  it('refuses an orgId naming a personal org, which owns nothing shared', async () => {
    projectRow.value = { slug: 'solo', name: 'Solo', orgId: ORG_ID, orgIsPersonal: true };

    const res = await connect(`?orgId=${ORG_ID}`);

    expect(res.status).toBe(409);
    expect((await bodyOf(res)).message).toContain('no shared org');
  });

  it("refuses an orgId query that is not the project's own org", async () => {
    const res = await connect(`?orgId=${OTHER_ORG_ID}`);

    expect(res.status).toBe(409);
    expect((await bodyOf(res)).code).toBe('ORG_MISMATCH');
  });

  it('accepts an orgId query that agrees with the project', async () => {
    const res = await connect(`?orgId=${ORG_ID}`);

    expect(res.status).toBe(200);
    expect(ownerOfSignedState(await bodyOf(res)).orgId).toBe(ORG_ID);
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
