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
};

beforeEach(() => {
  state.held = new Set(['project.read', 'project.write']);
  state.host = host;
  state.hostError = null;
  state.sentry = null;
  state.bindings = [];
  state.coolifyRows = [];
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

  it('serves no merge, close or branch delete', async () => {
    const base = `/${P}/integrations/source/change-requests/3`;
    for (const verb of ['merge', 'close', 'delete-branch']) {
      expect((await post(`${base}/${verb}`, {})).status).toBe(404);
    }
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

  it('answers a Sentry it cannot read as ok:false with a reason, and no issues key', async () => {
    const { SentryRefusal } = await import('../integrations/sentry/index.js');
    state.sentry = async () => {
      throw new SentryRefusal('not_granted', 'agent access is none');
    };
    const body = (await (await app().request(`/${P}/integrations/sentry/issues`)).json()) as Record<
      string,
      unknown
    >;
    expect(body.ok).toBe(false);
    expect(body).not.toHaveProperty('issues');
    expect(body.refusal).toMatchObject({ reason: 'not_granted' });
  });

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
