/**
 * ISS-1140 — what `forge_github action=list` says about a binding's inbound door.
 *
 * The report contacts GitHub not at all: where GitHub says it is addressed was read and stored by
 * the health probe, and the comparison against what THIS binding needs happens here, because the
 * URL carries a project slug and one connection may serve bindings in several projects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listBindingsForProjectMock = vi.fn();
const installationTokenMock = vi.fn();

// A whole mock rather than a partial one: the real module imports `db/client`, which parses the
// server env at import time, and nothing here needs a database. `effectiveConfig` is restated
// because it is pure and the binding-over-connection overlay is what decides which repository a
// refusal names.
vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x/y',
    DEVICE_TOKEN_PEPPER: 'pepper',
    PUBLIC_API_BASE_URL: 'https://api.example.test',
  },
}));
// ISS-1140: `list` now reads the project's slug to build the URL this binding needs GitHub to
// call. One row, one query, and `db` is otherwise untouched here.
let projectSlug: string | null = 'forge-dev';
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (projectSlug ? [{ slug: projectSlug }] : []) }),
      }),
    }),
  },
}));
vi.mock('../store.js', () => ({
  listBindingsForProject: (...a: unknown[]) => listBindingsForProjectMock(...(a as [])),
  decryptConnectionSecrets: (connection: { secretsPlain?: Record<string, unknown> }) =>
    connection.secretsPlain ?? {},
  effectiveConfig: (pair: {
    connection: { config?: Record<string, unknown> };
    binding: { config?: Record<string, unknown> };
  }) => ({ ...(pair.connection.config ?? {}), ...(pair.binding.config ?? {}) }),
}));
// The door's traffic is a database reading and `db/client` is a stub here, so the reading is
// mocked and what each case asserts is what the report DOES with it.
const NO_TRAFFIC = {
  accepted: 0,
  lastAcceptedAt: null as Date | null,
  refusalRecords: 0,
  lastRecordedRefusalAt: null as Date | null,
  lastRefusalCode: null as string | null,
};
const trafficMock = vi.fn(async (_bindingId: string) => ({ ...NO_TRAFFIC }));
vi.mock('../inbound-door.js', async () => {
  const real = await vi.importActual<typeof import('../inbound-door.js')>('../inbound-door.js');
  return { ...real, readInboundDoorTraffic: (id: string) => trafficMock(id) };
});
vi.mock('./app-auth.js', async () => {
  const real = await vi.importActual<typeof import('./app-auth.js')>('./app-auth.js');
  return { ...real, installationToken: (...a: unknown[]) => installationTokenMock(...(a as [])) };
});

const { githubAgentBindings } = await import('./agent-client.js');

// The grant is asked of the registry, so github's declaration has to be in it. An empty registry
// would refuse every case in this file for the wrong reason while still going red.
const { registerAllIntegrations } = await import('../register-all.js');
registerAllIntegrations();

const PROJECT = '66666666-6666-4666-8666-666666666666';
const originalFetch = globalThis.fetch;

function row(opts: {
  id?: string;
  bindingActive?: boolean;
  connectionActive?: boolean;
  agentAccess?: string;
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  createdAt?: Date;
  provider?: string;
  connectionId?: string;
  lastHealthStatus?: string | null;
  lastHealthDetail?: string | null;
  observed?: {
    url: string | null;
    active: boolean | null;
    observedAt: string;
    readError?: string;
  } | null;
}) {
  return {
    binding: {
      id: opts.id ?? 'bind-1',
      connectionId: 'conn-1',
      projectId: PROJECT,
      provider: opts.provider ?? 'github',
      config: opts.config ?? { owner: 'SidCorp-co', repo: 'forge-dev', installationId: 42 },
      active: opts.bindingActive ?? true,
      agentAccess: opts.agentAccess ?? 'all',
      createdAt: opts.createdAt ?? new Date('2026-01-01T00:00:00Z'),
    },
    connection: {
      id: opts.connectionId ?? 'conn-1',
      active: opts.connectionActive ?? true,
      config: {},
      secretsEnc: Buffer.from('x'),
      lastHealthStatus: opts.lastHealthStatus === undefined ? 'ok' : opts.lastHealthStatus,
      lastHealthDetail: opts.lastHealthDetail ?? null,
      inboundEndpointObserved:
        opts.observed === undefined
          ? { url: HERE, active: true, observedAt: '2026-09-21T00:00:00.000Z' }
          : opts.observed,
      secretsPlain: opts.secrets ?? { appId: '1234', privateKey: 'k'.repeat(120) },
    },
  };
}

/** The URL a `forge-dev` binding on this core needs GitHub to call. */
const HERE = 'https://api.example.test/api/webhooks/in/forge-dev';

beforeEach(() => {
  listBindingsForProjectMock.mockReset();
  installationTokenMock.mockReset();
  installationTokenMock.mockResolvedValue('ghs_installation_token_value');
  projectSlug = 'forge-dev';
  trafficMock.mockReset();
  trafficMock.mockImplementation(async () => ({ ...NO_TRAFFIC }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});
describe('list reports what exists, whatever the grant says', () => {
  // ISS-1074 criterion 13.
  it('reports an ungranted binding with agentGranted false, and contacts GitHub not at all', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    listBindingsForProjectMock.mockResolvedValue([
      row({ id: 'bind-ungranted', agentAccess: 'none' }),
    ]);

    trafficMock.mockResolvedValue({
      ...NO_TRAFFIC,
      accepted: 3,
      lastAcceptedAt: new Date('2026-09-20T10:00:00.000Z'),
    });
    await expect(githubAgentBindings(PROJECT)).resolves.toMatchObject([
      {
        bindingId: 'bind-ungranted',
        repository: 'SidCorp-co/forge-dev',
        installed: true,
        bindingActive: true,
        connectionActive: true,
        agentGranted: false,
        lastHealthStatus: 'ok',
        connectionProbeStatus: 'ok',
        inboundDoor: 'open',
        inboundDeliveries: 3,
        lastInboundDeliveryAt: '2026-09-20T10:00:00.000Z',
        turnedAwayRecords: 0,
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(installationTokenMock).not.toHaveBeenCalled();
  });

  it('answers an empty list for a project that has bound nothing, rather than refusing', async () => {
    listBindingsForProjectMock.mockResolvedValue([]);
    await expect(githubAgentBindings(PROJECT)).resolves.toEqual([]);
  });

  // ISS-1123 reported the door beside the flags; ISS-1140 makes the health answer for it. This is
  // the exact state the issue was filed on: installed, active, granted, outbound probe green, and
  // nothing has ever come in. Criteria 4 and 19.
  it('refuses to call a binding ok when nothing has ever come through its door', async () => {
    listBindingsForProjectMock.mockResolvedValue([row({ id: 'bind-silent' })]);
    const [report] = await githubAgentBindings(PROJECT);
    expect(report).toMatchObject({
      bindingId: 'bind-silent',
      connectionProbeStatus: 'ok',
      lastHealthStatus: 'degraded',
      inboundDoor: 'silent',
      inboundDeliveries: 0,
      lastInboundDeliveryAt: null,
    });
    expect(report?.inboundReading).toContain('nothing has ever come through it');
    expect(report?.inboundReading).toContain('Recent Deliveries');
  });

  // Criterion 5 — the happy case, and the only shape that earns `ok`.
  it('reports ok once the door is addressed here, active, and has carried something', async () => {
    trafficMock.mockResolvedValue({
      ...NO_TRAFFIC,
      accepted: 12,
      lastAcceptedAt: new Date('2026-09-19T08:00:00.000Z'),
    });
    listBindingsForProjectMock.mockResolvedValue([row({})]);
    await expect(githubAgentBindings(PROJECT)).resolves.toMatchObject([
      {
        lastHealthStatus: 'ok',
        inboundDoor: 'open',
        inboundDeliveries: 12,
        lastInboundDeliveryAt: '2026-09-19T08:00:00.000Z',
      },
    ]);
  });

  // Criteria 1 and 2 — the fault that actually happened on this project: GitHub was addressed at
  // the web frontend, which serves no such route, and the binding reported `ok` for three days.
  it('names both URLs when GitHub is addressed somewhere that is not this binding', async () => {
    listBindingsForProjectMock.mockResolvedValue([
      row({
        observed: {
          url: 'https://web.example.test/api/webhooks/in/forge-dev',
          active: true,
          observedAt: '2026-09-21T00:00:00.000Z',
        },
      }),
    ]);
    const [report] = await githubAgentBindings(PROJECT);
    expect(report?.lastHealthStatus).toBe('degraded');
    expect(report?.inboundDoor).toBe('elsewhere');
    expect(report?.observedWebhookUrl).toBe('https://web.example.test/api/webhooks/in/forge-dev');
    expect(report?.expectedWebhookUrl).toBe(HERE);
    expect(report?.inboundReading).toContain('https://web.example.test/api/webhooks/in/forge-dev');
    expect(report?.inboundReading).toContain(HERE);
  });

  // Criterion 18. The probe runs against ONE binding per connection, oldest first, so a verdict
  // stored on the shared connection would speak for a project it was never about. Here the App is
  // addressed at the older binding's project and the younger one must still say so.
  it('judges two bindings sharing one connection against their own URLs', async () => {
    projectSlug = 'other-project';
    listBindingsForProjectMock.mockResolvedValue([
      row({
        id: 'bind-other-project',
        observed: {
          url: HERE,
          active: true,
          observedAt: '2026-09-21T00:00:00.000Z',
        },
      }),
    ]);
    const [report] = await githubAgentBindings(PROJECT);
    expect(report?.expectedWebhookUrl).toBe(
      'https://api.example.test/api/webhooks/in/other-project',
    );
    expect(report?.inboundDoor).toBe('elsewhere');
    expect(report?.lastHealthStatus).toBe('degraded');
  });

  // Criteria 10 and 11. A turn-away is unauthenticated, so the reading reports that calls are
  // arriving and refuses to name who sent them.
  it('reports turned-away calls without naming a sender, and not as deliveries', async () => {
    trafficMock.mockResolvedValue({
      accepted: 0,
      lastAcceptedAt: null,
      refusalRecords: 4,
      lastRecordedRefusalAt: new Date('2026-09-21T09:00:00.000Z'),
      lastRefusalCode: 'INVALID_SIGNATURE',
    });
    listBindingsForProjectMock.mockResolvedValue([row({})]);
    const [report] = await githubAgentBindings(PROJECT);
    expect(report?.inboundDeliveries).toBe(0);
    expect(report?.turnedAwayRecords).toBe(4);
    expect(report?.lastTurnedAwayCode).toBe('INVALID_SIGNATURE');
    expect(report?.inboundReading).toContain('unauthenticated');
    expect(report?.inboundReading).not.toMatch(/GitHub (sent|called) (it|them)/);
  });

  // Criterion 13. A probe that found something worse is what an operator must act on first.
  it('leaves an outbound failure standing rather than replacing it with a door verdict', async () => {
    listBindingsForProjectMock.mockResolvedValue([
      row({ lastHealthStatus: 'needs_reauth', lastHealthDetail: 'the App JWT was rejected' }),
    ]);
    await expect(githubAgentBindings(PROJECT)).resolves.toMatchObject([
      {
        lastHealthStatus: 'needs_reauth',
        connectionProbeStatus: 'needs_reauth',
        healthDetail: 'the App JWT was rejected',
        inboundDoor: 'silent',
      },
    ]);
  });

  // Criterion 17 at the read: a probe that could not ask must not read as a door that is fine.
  it('says the configuration could not be read rather than reporting ok', async () => {
    trafficMock.mockResolvedValue({ ...NO_TRAFFIC, accepted: 9 });
    listBindingsForProjectMock.mockResolvedValue([
      row({
        observed: {
          url: null,
          active: null,
          observedAt: '2026-09-21T00:00:00.000Z',
          readError: 'GitHub returned HTTP 502',
        },
      }),
    ]);
    const [report] = await githubAgentBindings(PROJECT);
    expect(report?.inboundDoor).toBe('unreadable');
    expect(report?.lastHealthStatus).toBe('degraded');
    expect(report?.inboundReading).toContain('HTTP 502');
  });
});
