// A GitLab project's hooks list holds whatever its owners set up: a deploy hook of another service,
// with its own secret in the URL, sits beside Forge's. The health check judges Forge's hook alone, and
// never stores, says or returns another hook's address.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateConnection = vi.fn(async (_id: string, _patch: Record<string, unknown>) => {});
let apiBase: string | null = 'https://forge-dev-api.sidcorp.co';

vi.mock('../index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateConnection,
  resolveApiBaseUrl: () => apiBase,
  forgeReads: () => ({ projectSlug: async () => 'adminhub-fe' }),
}));

const { gitlabIntegration } = await import('./adapter.js');
const { ownObservation } = await import('./report.js');
const adapter = gitlabIntegration.adapter as NonNullable<typeof gitlabIntegration.adapter>;

const OURS = 'https://forge-dev-api.sidcorp.co/api/webhooks/in/adminhub-fe';
const SECRET = 'deploy-secret-0123456789';
const FOREIGN = `https://forge.laravel.com/servers/1/sites/2/deploy/http?token=${SECRET}`;
const ALL_EVENTS = { push_events: true, merge_requests_events: true, pipeline_events: true };

const ctx = {
  projectId: 'p1',
  bindingId: 'b1',
  connectionId: 'c1',
  config: { projectPath: 'sidcorp-it/canawan-admin-hub-fe', baseUrl: 'https://gitlab.example.com' },
  secrets: { token: 'glpat-x' },
} as never;

/** GitLab answering the project read and its hooks list with `hooks`. */
function gitlab(hooks: unknown[]) {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
    if (path.endsWith('/hooks')) return Response.json(hooks);
    return Response.json({
      path_with_namespace: 'sidcorp-it/canawan-admin-hub-fe',
      default_branch: 'main',
    });
  });
}

/** What the check stored as its observation of the hooks. */
const observed = () =>
  updateConnection.mock.calls.map(([, p]) => p.inboundEndpointObserved).find(Boolean) as
    | { url: string | null; active: boolean | null }
    | undefined;

/** Everything the check let out: its answer and every write it made. */
const said = (result: unknown) => JSON.stringify([result, updateConnection.mock.calls]);

beforeEach(() => {
  updateConnection.mockClear();
  apiBase = 'https://forge-dev-api.sidcorp.co';
});
afterEach(() => vi.unstubAllGlobals());

describe("gitlab healthcheck: another service's hook", () => {
  it("PLANT: a list holding only another hook says Forge's is missing, and never stores or says that hook", async () => {
    gitlab([{ url: FOREIGN, push_events: true }]);
    const result = await adapter.healthcheck(ctx);
    expect(result.status).toBe('degraded');
    expect(result.message).toBe(
      `no GitLab webhook calls ${OURS}: add one there with the binding's secret`,
    );
    expect(observed()).toMatchObject({ url: null, active: null });
    expect(said(result)).not.toContain(SECRET);
    expect(said(result)).not.toContain('forge.laravel.com');
  });

  it("judges Forge's own hook when another sits beside it, and names only Forge's", async () => {
    gitlab([
      { url: FOREIGN, ...ALL_EVENTS },
      { url: OURS, push_events: true },
    ]);
    const result = await adapter.healthcheck(ctx);
    expect(result.message).toBe(
      `the GitLab webhook at ${OURS} does not send merge_requests_events, pipeline_events`,
    );
    expect(observed()).toMatchObject({ url: OURS, active: true });
    expect(said(result)).not.toContain(SECRET);
  });

  it("knows Forge's hook through a trailing slash and a capitalised host, as the read side does", async () => {
    gitlab([
      { url: 'https://Forge-Dev-API.sidcorp.co/api/webhooks/in/adminhub-fe/', ...ALL_EVENTS },
    ]);
    const result = await adapter.healthcheck(ctx);
    expect(result.status).toBe('ok');
    expect(observed()?.url).not.toBeNull();
  });

  it("is ok when Forge's hook sends every event, whatever else the list holds", async () => {
    gitlab([{ url: FOREIGN }, { url: OURS, ...ALL_EVENTS }]);
    const result = await adapter.healthcheck(ctx);
    expect(result.status).toBe('ok');
    expect(observed()).toMatchObject({ url: OURS });
  });

  it('with no address of its own to match, judges no hook and records none', async () => {
    apiBase = null;
    gitlab([{ url: FOREIGN, ...ALL_EVENTS }]);
    const result = await adapter.healthcheck(ctx);
    expect(result.status).toBe('degraded');
    expect(result.message).toBe(
      "no GitLab webhook calls this core's /api/webhooks/in/<project slug>: add one there with the binding's secret",
    );
    expect(observed()).toMatchObject({ url: null });
    expect(said(result)).not.toContain(SECRET);
  });
});

describe('a stored observation of another hook, from before this check', () => {
  const at = { observedAt: '2026-10-15T00:00:00.000Z' };

  it("PLANT: is read back as no hook of Forge's, never as the other hook's address", () => {
    const read = ownObservation({ url: FOREIGN, active: true, ...at }, OURS);
    expect(read).toMatchObject({ url: null, active: null });
    expect(JSON.stringify(read)).not.toContain(SECRET);
    expect(ownObservation({ url: FOREIGN, active: true, ...at }, null)?.url).toBeNull();
  });

  it("keeps an observation of Forge's own hook, and one that found none", () => {
    expect(ownObservation({ url: `${OURS}/`, active: true, ...at }, OURS)?.url).toBe(`${OURS}/`);
    expect(ownObservation({ url: null, active: null, ...at }, OURS)).toMatchObject({ url: null });
    expect(ownObservation(null, OURS)).toBeNull();
  });
});
