// The delivery doors that left the MCP server, over REST: each keeps the authorization, the bounds
// and the refusals the tool had, and nothing on the source door merges.
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error.js';

const state = vi.hoisted(() => ({
  held: new Set<string>(['project.read', 'project.write']),
  host: null as unknown,
  hostError: null as Error | null,
  sentry: null as (() => Promise<unknown>) | null,
  projected: [] as unknown[],
  projectError: null as Error | null,
  bindings: [] as unknown[],
  coolifyRows: [] as unknown[],
}));

vi.mock('../permissions/index.js', () => ({
  actorFor: (id: string) => ({ id }),
  projectResource: (id: string) => ({ id }),
  requireCan: async (_actor: unknown, action: string) => {
    if (!state.held.has(action)) {
      throw new HTTPException(403, { message: `needs ${action}`, cause: { code: 'FORBIDDEN' } });
    }
  },
}));

vi.mock('../integrations/source-host/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../integrations/source-host/index.js')>();
  return {
    ...real,
    resolveSourceHost: async () => {
      if (state.hostError) throw state.hostError;
      return state.host;
    },
    projectOpenedPullRequest: async () => ({ outcome: 'recorded', issueId: null }),
    projectReadChangeRequest: async (args: { read: unknown }) => {
      if (state.projectError) throw state.projectError;
      state.projected.push(args.read);
      return { projection: { outcome: 'recorded', issueIds: [] }, facts: [] };
    },
  };
});

vi.mock('../integrations/sentry/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../integrations/sentry/index.js')>();
  return {
    ...real,
    readProjectSentryIssues: async (req: unknown) => (state.sentry ? state.sentry() : { req }),
    readProjectSentryIssue: async (req: unknown) => ({ req }),
  };
});

vi.mock('../integrations/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../integrations/index.js')>();
  return {
    ...real,
    listIntegrations: () => [
      {
        provider: 'autoflow',
        storefrontTarget: async () => ({ shop: 'acme' }),
        sourceHost: { listBindings: async () => state.bindings },
      },
    ],
    listActiveBindingsForProjectProvider: async () => [
      {
        binding: { id: 'b1', label: 'main' },
        connection: { id: 'c1' },
      },
    ],
    effectiveConfig: () => ({}),
    decryptConnectionSecrets: async () => ({}),
    findLastOutbound: async () => null,
  };
});
vi.mock('./mcp-preview-service.js', () => ({ buildMcpPreview: async () => ({ servers: [] }) }));

vi.mock('../release-batch/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../release-batch/index.js')>();
  return { ...real, activeCoolifyIntegrations: async () => state.coolifyRows };
});

const { registerSourceRoutes } = await import('./source-routes.js');
const { registerSentryRoutes } = await import('./sentry-routes.js');
const { registerStorefrontRoutes } = await import('./storefront-routes.js');
const { registerCoolifyDeployRoutes } = await import('./coolify-routes.js');

const P = '00000000-0000-4000-8000-000000000001';

function app() {
  // biome-ignore lint/suspicious/noExplicitAny: the routes' AuthVars carry more than a test sets
  const a = new Hono<any>();
  a.use('*', async (c, next) => {
    c.set('userId', 'u1');
    await next();
  });
  registerSourceRoutes(a);
  registerSentryRoutes(a);
  registerStorefrontRoutes(a);
  registerCoolifyDeployRoutes(a);
  a.onError(errorHandler as never);
  return a;
}

const post = (path: string, body: unknown) =>
  app().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const codeOf = async (res: Response) =>
  ((await res.json()) as { error?: { code?: string } }).error?.code;

const host = {
  provider: 'github',
  bindingId: 'b1',
  fullName: 'acme/shop',
  words: { changeRequest: 'pull request', sigil: '#' },
  diff: vi.fn(async ({ number }: { number: number }) => ({ number, diff: '+x' })),
  checkLog: vi.fn(async (input: unknown) => input),
  comment: vi.fn(async () => ({ commentId: 1 })),
  requestReview: vi.fn(async (input: unknown) => input),
  openChangeRequest: vi.fn(async () => ({ number: 7, url: 'u' })),
  submitReview: vi.fn(),
  readCommit: vi.fn(async (ref: string) =>
    ref.startsWith('abc1234') ? { sha: FULL, message: 'm', committedAt: null } : null,
  ),
  branchHead: vi.fn(async () => FULL),
  readChecks: vi.fn(async (): Promise<unknown[]> => []),
  readChangeRequestChecks: vi.fn(async (): Promise<unknown[]> => []),
  readChangeRequest: vi.fn(async (number: number) => ({ number, state: 'open' })),
  updateChangeRequest: vi.fn(async (input: { number: number }) => ({ ...input, state: 'open' })),
  closeChangeRequest: vi.fn(async ({ number }: { number: number }) => ({
    number,
    state: 'closed',
  })),
};

const FULL = `abc1234${'0'.repeat(33)}`;

const check = (id: string, name: string, status: string, conclusion: string | null) => ({
  id,
  name,
  app: 'gitlab-ci',
  headSha: FULL,
  status,
  conclusion,
  detailsUrl: null,
  startedAt: `2026-10-26T08:0${id}:00Z`,
  completedAt: null,
});

beforeEach(() => {
  state.held = new Set(['project.read', 'project.write']);
  state.host = host;
  state.hostError = null;
  state.sentry = null;
  state.bindings = [];
  state.coolifyRows = [];
  state.projected = [];
  state.projectError = null;
  vi.clearAllMocks();
});

describe('the source door', () => {
  it('reads a diff by the number the host shows', async () => {
    const res = await app().request(`/${P}/integrations/source/change-requests/12/diff`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ number: 12, diff: '+x' });
  });

  it('lists the bindings without reaching a host', async () => {
    state.bindings = [{ provider: 'github', health: 'ok' }];
    state.hostError = new Error('a list must not resolve the host');
    const res = await app().request(`/${P}/integrations/source`);
    expect(await res.json()).toEqual({ bindings: [{ provider: 'github', health: 'ok' }] });
  });

  it('refuses a check log longer than 1000 lines rather than clamping it', async () => {
    const res = await app().request(`/${P}/integrations/source/checks/5/log?lines=1001`);
    expect(res.status).toBe(400);
    expect(host.checkLog).not.toHaveBeenCalled();
    const ok = await app().request(`/${P}/integrations/source/checks/5/log?lines=1000`);
    expect(await ok.json()).toEqual({ checkRunId: 5, lines: 1000 });
  });

  it('holds a writer to comment, open, request reviewers and review; a reader may only read', async () => {
    state.held = new Set(['project.read']);
    const base = `/${P}/integrations/source/change-requests`;
    for (const [path, body] of [
      [`${base}/3/comments`, { body: 'hi' }],
      [base, { head: 'h', base: 'dev', title: 't' }],
      [`${base}/3/reviewers`, { reviewers: ['ann'] }],
      [`${base}/3/reviews`, { verdict: 'APPROVE', body: 'ok' }],
    ] as const) {
      expect((await post(path, body)).status).toBe(403);
    }
    expect(host.comment).not.toHaveBeenCalled();
    expect(host.openChangeRequest).not.toHaveBeenCalled();
    expect((await app().request(`${base}/3/diff`)).status).toBe(200);
  });

  it('names nobody it was not given: a reviewers request with none is refused', async () => {
    const res = await post(`/${P}/integrations/source/change-requests/3/reviewers`, {});
    expect(res.status).toBe(400);
    expect(host.requestReview).not.toHaveBeenCalled();
  });

  it('records what it opens on the projection', async () => {
    const res = await post(`/${P}/integrations/source/change-requests`, {
      head: 'iss-1',
      base: 'dev',
      title: 'ISS-1',
    });
    expect(await res.json()).toMatchObject({ number: 7, projection: { outcome: 'recorded' } });
  });

  it('refuses a binding agents may not use by name, with its reason', async () => {
    const { SourceHostUnavailable } = await import('../integrations/source-host/index.js');
    state.hostError = new SourceHostUnavailable('not_granted', 'binding b1 is not granted', 'b1');
    const res = await app().request(`/${P}/integrations/source/change-requests/1/diff`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('SOURCE_HOST_UNAVAILABLE');
    expect(JSON.stringify(body)).toContain('not_granted');
  });

  it('serves no merge or branch delete', async () => {
    const base = `/${P}/integrations/source/change-requests/3`;
    for (const verb of ['merge', 'delete-branch']) {
      expect((await post(`${base}/${verb}`, {})).status).toBe(404);
    }
  });
});

describe('the source door with no webhook: checks, edit, close and refresh', () => {
  const base = `/${P}/integrations/source`;
  const send = (method: string, path: string, body?: unknown) =>
    app().request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('reads a commit’s checks at its whole sha, the latest run per name rolled up', async () => {
    host.readChecks.mockResolvedValueOnce([
      check('1', 'pipeline', 'completed', 'failure'),
      check('2', 'pipeline', 'completed', 'success'),
      check('3', 'nightly', 'in_progress', null),
    ]);
    const res = await app().request(`${base}/commits/abc1234/checks`);
    expect(res.status).toBe(200);
    expect(host.readChecks).toHaveBeenCalledWith(FULL);
    expect(await res.json()).toMatchObject({
      sha: FULL,
      state: 'pending',
      rollup: { total: 2, success: 1, failure: 0, pending: 1 },
    });
  });

  it('answers `none`, never a green, where nothing ran on the commit', async () => {
    const res = await app().request(`${base}/commits/abc1234/checks`);
    expect(await res.json()).toMatchObject({ state: 'none', rollup: { total: 0 } });
  });

  it('refuses a sha that names no commit, and one that is no sha, before reading checks', async () => {
    const unknown = await app().request(`${base}/commits/${'f'.repeat(40)}/checks`);
    expect(unknown.status).toBe(422);
    expect(await codeOf(unknown)).toBe('SOURCE_HOST_INPUT_REFUSED');
    const branch = await app().request(`${base}/commits/release-stg/checks`);
    expect(branch.status).toBe(400);
    expect(host.readChecks).not.toHaveBeenCalled();
  });

  it('reads a branch’s checks at its head, a slash in its name URL-encoded', async () => {
    host.readChecks.mockResolvedValueOnce([check('1', 'pipeline', 'completed', 'success')]);
    const res = await app().request(`${base}/branches/release%2Fstg/checks`);
    expect(res.status).toBe(200);
    expect(host.branchHead).toHaveBeenCalledWith('release/stg');
    expect(await res.json()).toMatchObject({ ref: 'release/stg', sha: FULL, state: 'success' });
  });

  it('holds a writer to edit, close and refresh; a reader may read checks', async () => {
    state.held = new Set(['project.read']);
    expect((await send('PATCH', `${base}/change-requests/3`, { title: 't' })).status).toBe(403);
    expect((await post(`${base}/change-requests/3/close`, {})).status).toBe(403);
    expect((await post(`${base}/change-requests/3/refresh`, {})).status).toBe(403);
    expect(host.updateChangeRequest).not.toHaveBeenCalled();
    expect(host.closeChangeRequest).not.toHaveBeenCalled();
    expect(host.readChangeRequest).not.toHaveBeenCalled();
    expect((await app().request(`${base}/branches/main/checks`)).status).toBe(200);
  });

  it('refuses an edit that changes nothing, and sends nothing', async () => {
    const res = await send('PATCH', `${base}/change-requests/3`, {});
    expect(res.status).toBe(400);
    expect(host.updateChangeRequest).not.toHaveBeenCalled();
  });

  it('edits, closes and refreshes, projecting what the host answered each time', async () => {
    const edited = await send('PATCH', `${base}/change-requests/3`, { body: 'pairs with ISS-2' });
    expect(await edited.json()).toMatchObject({ number: 3, projection: { outcome: 'recorded' } });
    expect(host.updateChangeRequest).toHaveBeenCalledWith({ number: 3, body: 'pairs with ISS-2' });
    const closed = await post(`${base}/change-requests/3/close`, {});
    expect(await closed.json()).toMatchObject({
      state: 'closed',
      projection: { outcome: 'recorded' },
    });
    const read = await post(`${base}/change-requests/3/refresh`, {});
    expect(await read.json()).toMatchObject({ number: 3, projection: { outcome: 'recorded' } });
    expect(state.projected).toHaveLength(3);
  });

  it('reports a projection that failed after the host took the edit, never an error', async () => {
    state.projectError = new Error('the row would not write');
    const res = await post(`${base}/change-requests/3/close`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projection: { outcome: string; reason: string } };
    expect(body.projection.outcome).toBe('not-recorded');
    expect(body.projection.reason).toContain('STANDS');
    expect(body.projection.reason).toContain('/refresh');
  });

  it('refuses a refresh whose projection cannot be written, since nothing else happened', async () => {
    const { SourceHostCallError } = await import('../integrations/source-host/index.js');
    state.projectError = new SourceHostCallError(200, 'gitlab answered !3 with no base sha');
    const res = await post(`${base}/change-requests/3/refresh`, {});
    expect(await codeOf(res)).toBe('HOST_UNAVAILABLE');
  });
});

describe('the sentry door', () => {
  it('passes only the filters given, and answers ok:true', async () => {
    const res = await app().request(`/${P}/integrations/sentry/issues?release=abc&limit=5`);
    expect(await res.json()).toEqual({
      ok: true,
      req: { projectId: P, release: 'abc', limit: 5 },
    });
  });

  it.each([
    ['SENTRY_NOT_GRANTED', 403],
    ['SENTRY_CREDENTIAL_REJECTED', 503],
    ['SENTRY_TARGET_UNKNOWN', 400],
    ['SENTRY_CONFINED_OUT', 404],
    ['SENTRY_NO_BINDING', 422],
  ] as const)(
    'refuses a Sentry it cannot read in the envelope: %s answers %i',
    async (code, status) => {
      const { refuseSentry } = await import('../integrations/sentry/index.js');
      state.sentry = async () => {
        throw refuseSentry(code, 'agent access is none');
      };
      const res = await app().request(`/${P}/integrations/sentry/issues`);
      expect(res.status).toBe(status);
      const body = (await res.json()) as {
        error: { code: string; message: string; refusals: { code: string }[] };
        issues?: unknown;
      };
      expect(body.error.code).toBe(code);
      expect(body.error.refusals[0]?.code).toBe(code);
      expect(body).not.toHaveProperty('issues');
    },
  );

  it('refuses a stranger before it reads anything', async () => {
    state.held = new Set();
    expect((await app().request(`/${P}/integrations/sentry/issues/ABC-1`)).status).toBe(403);
  });
});

describe('the storefront door', () => {
  it('answers the labelled store', async () => {
    const res = await app().request(`/${P}/integrations/storefront/target?label=main`);
    expect(await res.json()).toMatchObject({
      configured: true,
      provider: 'autoflow',
      shop: 'acme',
    });
  });

  it('refuses a label no binding carries, naming the labels there are', async () => {
    const res = await app().request(`/${P}/integrations/storefront/target?label=outlet`);
    expect(await codeOf(res)).toBe('STOREFRONT_LABEL_UNKNOWN');
  });
});

describe('the coolify log doors', () => {
  it('rejects lines outside 1..1000 rather than clamping', async () => {
    expect((await app().request(`/${P}/integrations/coolify/logs?lines=0`)).status).toBe(400);
    expect((await app().request(`/${P}/integrations/coolify/runtime-logs?lines=5000`)).status).toBe(
      400,
    );
  });

  it('says there is no integration rather than an empty log', async () => {
    const res = await app().request(`/${P}/integrations/coolify/logs`);
    expect(await res.json()).toMatchObject({ logs: null, reason: 'no-integration' });
  });

  it('refuses a runtime log of an integration with several targets until one is named', async () => {
    state.coolifyRows = [
      { id: 'i1', config: { targets: [{ resourceUuid: 'a' }, { resourceUuid: 'b' }] }, pair: {} },
    ];
    const res = await app().request(`/${P}/integrations/coolify/runtime-logs`);
    expect(await codeOf(res)).toBe('COOLIFY_TARGET_UNRESOLVED');
  });
});
