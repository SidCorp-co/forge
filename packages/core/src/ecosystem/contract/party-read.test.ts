import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../../middleware/error.js';

const PROVIDER = '00000000-0000-4000-8000-0000000000a1';
const FELLOW = '00000000-0000-4000-8000-0000000000f1';
const CONSUMER = '00000000-0000-4000-8000-0000000000c1';
const OUTSIDER = '00000000-0000-4000-8000-0000000000d1';
const ECO = '00000000-0000-4000-8000-0000000000e1';
const OTHER_ECO = '00000000-0000-4000-8000-0000000000e2';
const CONTRACT = 'admin-rest-v1';

const state = vi.hoisted(() => ({ reads: [] as string[] }));

vi.mock('../../middleware/auth.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../middleware/auth.js')>();
  return {
    ...real,
    requireAuth:
      () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
        c.set('userId', 'u1');
        await next();
      },
    assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
  };
});
// the caller holds a role on exactly the projects in `state.reads`, as a token fenced to them would
vi.mock('../../lib/authz.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/authz.js')>();
  const access = (projectId: string) => ({
    projectId,
    role: state.reads.includes(projectId) ? 'member' : null,
    grants: [],
  });
  return {
    ...real,
    loadProjectAccess: async (projectId: string) => access(projectId),
    effectiveProjectRole: async (_u: string, projectId: string) =>
      state.reads.includes(projectId) ? access(projectId) : null,
    loadVisibleProjectIds: async () => [...state.reads],
  };
});
vi.mock('../graph.js', () => ({
  loadGraph: async (ids: readonly string[]) => ({
    active: new Map(
      ids.map((id) => [
        id,
        new Set(id === ECO ? [PROVIDER, FELLOW, CONSUMER] : id === OTHER_ECO ? [OUTSIDER] : []),
      ]),
    ),
    visibility: new Map(ids.map((id) => [id, 'counterparties'])),
    edges: ids.includes(ECO)
      ? [
          {
            consumerProjectId: CONSUMER,
            providerProjectId: PROVIDER,
            contractSlug: CONTRACT,
            ecosystemId: ECO,
            builtAgainst: '3.0.0',
          },
        ]
      : [],
  }),
}));
vi.mock('../membership-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../membership-store.js')>();
  const of = (p: string) => (p === OUTSIDER ? OTHER_ECO : ECO);
  return {
    ...real,
    activeEcosystemIdsOf: async (_tx: unknown, ids: readonly string[]) =>
      ids.map((projectId) => ({ projectId, ecosystemId: of(projectId) })),
    membershipsWhere: async (f: { projectIds?: string[] }) =>
      (f.projectIds ?? []).map((projectId) => ({
        id: `m-${projectId}`,
        projectId,
        ecosystemId: of(projectId),
        state: 'active',
      })),
  };
});
vi.mock('../membership-rules.js', () => ({ membershipDocument: () => ({}) }));
vi.mock('../ecosystem-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../ecosystem-service.js')>();
  return {
    ...real,
    heldEcosystem: (e: { id: string }) => ({
      document: {
        ecosystem: { slug: `eco-${e.id.slice(-2)}`, name: 'Epod', steward: 'org' },
        visibility: { members: 'counterparties' },
        channel: { code: 'EP' },
      },
    }),
  };
});
vi.mock('../interface-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../interface-service.js')>();
  return {
    ...real,
    commitmentsSetter: async () => null,
    loadInterface: async (projectId: string) =>
      projectId === PROVIDER
        ? {
            document: {
              publishes: {
                [CONTRACT]: {
                  title: 'Admin REST',
                  type: 'openapi',
                  artifact: null,
                  lifecycle: 'stable',
                  ecosystems: [ECO],
                },
                internal: {
                  title: 'In-project only',
                  type: 'openapi',
                  artifact: null,
                  lifecycle: 'stable',
                  ecosystems: [],
                },
              },
              commitments: { versioning: 'semver', deprecationNoticeDays: 30, responseDays: {} },
            },
          }
        : null,
  };
});
const version = (v: string, approval: string) => ({
  providerProjectId: PROVIDER,
  contractSlug: CONTRACT,
  version: v,
  contractType: 'openapi',
  recordedAt: new Date('2026-10-01T00:00:00Z'),
  artifactSha256: `sha-${v}`,
  elements: [`GET /items@${v}`],
  approval,
  decidedBy: approval === 'approved' ? 'person-1' : null,
  decidedAs: null,
  decidedAt: null,
  decisionReason: null,
  document: {
    contract: `catalog-api/${CONTRACT}`,
    contractVersion: v,
    previous: null,
    observedAt: '2026-10-01T00:00:00Z',
    artifact: { sha256: `sha-${v}` },
    diff: { tool: 'oasdiff', classification: 'non-breaking', changes: [] },
  },
});
const VERSIONS = [version('3.1.0', 'proposed'), version('3.0.0', 'approved')];
vi.mock('../store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../store.js')>();
  const named = (id: string) => ({ id, slug: `p-${id.slice(-2)}`, name: `P ${id.slice(-2)}` });
  return {
    ...real,
    projectsWhere: async (_tx: unknown, f: { ids: string[] }) => f.ids.map(named),
    readEcosystems: async (_tx: unknown, ids: readonly string[]) => ids.map((id) => ({ id })),
    recordedVersions: async (_tx: unknown, ids: readonly string[]) =>
      ids.includes(PROVIDER)
        ? [...VERSIONS].reverse().map((v) => ({
            providerProjectId: PROVIDER,
            contractSlug: CONTRACT,
            version: v.version,
            approval: v.approval,
          }))
        : [],
  };
});
vi.mock('./store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./store.js')>();
  return {
    ...real,
    versionsOf: async (_tx: unknown, ids: readonly string[], slug?: string) =>
      ids.includes(PROVIDER) && (slug === undefined || slug === CONTRACT) ? VERSIONS : [],
    readArtifact: async (_tx: unknown, sha: string) => `openapi bytes of ${sha}`,
  };
});

const { ecosystemProjectRoutes } = await import('../project-routes.js');
const { contractRoutes } = await import('./routes.js');

function app() {
  const a = new Hono().route('/', ecosystemProjectRoutes).route('/', contractRoutes);
  a.onError(errorHandler as never);
  return a;
}
interface Answer {
  publishes: { slug: string; versions: string[]; consumers: object[] }[];
  consumes: object[];
  reader: { access: string };
  versions: { contractVersion: string }[];
  current: string | null;
  elements: string[];
  approvals: Record<string, { decidedBy: string | null }>;
  error: { message: string };
  memberships: { peers: { project: { id: string }; publishes: object[] }[] }[];
}
const get = async (path: string) => {
  const res = await app().request(path);
  const text = await res.text();
  return { status: res.status, text, body: parsed(text) };
};
// an artifact answers its own bytes, which need not be JSON whatever media type it is served as
function parsed(text: string): Answer {
  try {
    return JSON.parse(text) as Answer;
  } catch {
    return {} as Answer;
  }
}

beforeEach(() => {
  state.reads = [];
});

describe('a fellow member of an ecosystem a contract is published to reads it before consuming', () => {
  it('reads the provider api page: the published contract with its approved versions only', async () => {
    state.reads = [FELLOW];
    const { status, body } = await get(`/${PROVIDER}/api-page`);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.publishes.map((p) => p.slug)).toEqual([CONTRACT]);
    expect(body.publishes[0]?.versions).toEqual(['3.0.0']);
    expect(body.publishes[0]?.consumers).toEqual([]);
    expect(body.consumes).toEqual([]);
    expect(body.reader.access).toBe('party');
  });

  it('lists the approved versions, reads one with its operations and fetches its artifact', async () => {
    state.reads = [FELLOW];
    const list = await get(`/${PROVIDER}/contracts/${CONTRACT}/versions`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.versions.map((v) => v.contractVersion)).toEqual(['3.0.0']);
    expect(list.body.current).toBe('3.0.0');
    expect(JSON.stringify(list.body)).not.toContain('person-1');
    const one = await get(`/${PROVIDER}/contracts/${CONTRACT}/versions/3.0.0`);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.elements).toEqual(['GET /items@3.0.0']);
    const art = await get(`/${PROVIDER}/contracts/${CONTRACT}/versions/3.0.0/artifact`);
    expect(art.status).toBe(200);
    expect(art.text).toBe('openapi bytes of sha-3.0.0');
  });

  it('never reads a proposed version, which is not yet the provider s word', async () => {
    state.reads = [FELLOW];
    const one = await get(`/${PROVIDER}/contracts/${CONTRACT}/versions/3.1.0`);
    expect(one.status).toBe(404);
    const art = await get(`/${PROVIDER}/contracts/${CONTRACT}/versions/3.1.0/artifact`);
    expect(art.status).toBe(404);
  });

  it('never reads a contract published to no ecosystem', async () => {
    state.reads = [FELLOW];
    const { status, body } = await get(`/${PROVIDER}/contracts/internal/versions`);
    expect(status, JSON.stringify(body)).toBe(403);
    expect(body.error.message).toContain('published to');
  });

  it('a consumer reading its consumed versions sees no proposed version either', async () => {
    state.reads = [CONSUMER];
    const { status, body } = await get(`/${CONSUMER}/consumes/${PROVIDER}/${CONTRACT}/versions`);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.versions.map((v) => v.contractVersion)).toEqual(['3.0.0']);
  });

  it('lists its ecosystems peers and what they publish there, read as its own project', async () => {
    state.reads = [FELLOW];
    const { status, body } = await get(`/${FELLOW}/ecosystems`);
    expect(status, JSON.stringify(body)).toBe(200);
    const peers = body.memberships[0]?.peers ?? [];
    expect(peers.map((p) => p.project.id)).toEqual([PROVIDER]);
    expect(peers[0]?.publishes).toEqual([
      {
        contract: `p-a1/${CONTRACT}`,
        slug: CONTRACT,
        title: 'Admin REST',
        type: 'openapi',
        current: '3.0.0',
      },
    ]);
  });
});

describe('a project outside every ecosystem the contract is published to', () => {
  it('is refused the api page and the contract, by name', async () => {
    state.reads = [OUTSIDER];
    const page = await get(`/${PROVIDER}/api-page`);
    expect(page.status).toBe(403);
    expect(page.body.error.message).toContain('published to');
    const list = await get(`/${PROVIDER}/contracts/${CONTRACT}/versions`);
    expect(list.status).toBe(403);
    const art = await get(`/${PROVIDER}/contracts/${CONTRACT}/versions/3.0.0/artifact`);
    expect(art.status).toBe(403);
  });
});

describe('a member of the provider', () => {
  it('still reads every version, proposed included, with its approval', async () => {
    state.reads = [PROVIDER];
    const list = await get(`/${PROVIDER}/contracts/${CONTRACT}/versions`);
    expect(list.status).toBe(200);
    expect(list.body.versions.map((v) => v.contractVersion)).toEqual(['3.1.0', '3.0.0']);
    expect(list.body.approvals['3.0.0']?.decidedBy).toBe('person-1');
  });
});
