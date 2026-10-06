import { SCHEMA_BASE } from '@forge/contracts/project-config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InterfaceDocument } from './schema.js';

const PROVIDER = '11111111-1111-4111-8111-111111111111';
const CONSUMER = '22222222-2222-4222-8222-222222222222';
const ECO = '33333333-3333-4333-8333-333333333333';
const OTHER_ECO = '44444444-4444-4444-8444-444444444444';
const SHA = 'a'.repeat(40);
const TX = { tx: true };

const doc = (provider: string, consumes: InterfaceDocument['consumes']): InterfaceDocument => ({
  $schema: `${SCHEMA_BASE}/interface-v1.json` as InterfaceDocument['$schema'],
  version: 1,
  project: provider,
  publishes: {},
  consumes,
  commitments: {
    versioning: 'semver',
    deprecationNoticeDays: 30,
    responseDays: { rfi: 5, 'change-request': 10 },
  },
});

const linkRow = (id: string, pinnedVersion: string, eco = ECO) => ({
  id,
  ecosystemId: eco,
  projectId: CONSUMER,
  providerProjectId: PROVIDER,
  contractSlug: 'admin-rest-v1',
  modulePath: `src/${id}`,
  pinnedVersion,
  state: 'current',
  revision: 4,
  writtenByUser: 'u0',
  createdAt: new Date(),
  updatedAt: new Date(),
  document: {
    $schema: `${SCHEMA_BASE}/link-v1.json`,
    version: 1,
    ecosystem: eco,
    consumer: { project: CONSUMER, module: `src/${id}` },
    contract: { provider: PROVIDER, slug: 'admin-rest-v1' },
    pinnedVersion,
    state: 'current',
    callSites: [{ path: `src/${id}.ts`, line: 3, operation: 'GET /products' }],
    fieldsUsed: ['name'],
    outsideContract: [],
    notes: [],
    writtenBy: { sha: SHA },
    refreshedAtSha: SHA,
  },
});

const version = (v: string, previous: string | null, classification: string, changes = []) => ({
  providerProjectId: PROVIDER,
  contractSlug: 'admin-rest-v1',
  version: v,
  approval: 'approved',
  elements: null,
  document: { previous, diff: { tool: 'oasdiff', classification, changes } },
});

const state = vi.hoisted(() => ({
  held: true,
  versions: [] as unknown[],
  links: [] as unknown[],
  writes: [] as [string, unknown, unknown][],
  interfaceRefusals: [] as { code: string; path: string; detail: string }[],
}));

vi.mock('../db/client.js', () => ({
  db: { transaction: async (fn: (tx: unknown) => unknown) => fn({ tx: true }) },
}));
vi.mock('../permissions/index.js', async (orig) => ({
  ...(await orig<object>()),
  permissionFactsOf: async () => ({}),
  permissionRefusal: (_f: unknown, permission: string, act: string) =>
    state.held
      ? null
      : { code: 'PERMISSION_FORBIDDEN', path: '/', detail: `${act} takes ${permission}` },
}));
vi.mock('../requirements/index.js', () => ({
  staleOnContract: async () => [
    {
      requirement: 'REQ-1',
      id: 'r1',
      contract: 'catalog-api/admin-rest-v1',
      pinned: '3.0.0',
      current: '3.1.1',
    },
  ],
}));
vi.mock('./store.js', async (orig) => ({
  ...(await orig<object>()),
  lockKeys: async () => {},
  projectsWhere: async (_tx: unknown, by: { ids?: string[]; slugs?: string[] }) =>
    by.ids
      ? [{ id: CONSUMER, slug: 'catalog-fe', name: 'fe' }]
      : [{ id: PROVIDER, slug: 'catalog-api', name: 'api' }],
}));
vi.mock('./interface-store.js', async (orig) => ({
  ...(await orig<object>()),
  readInterface: async (_tx: unknown, id: string) => ({
    revision: 7,
    updatedBy: 'u0',
    updatedAt: new Date(),
    document:
      id === CONSUMER
        ? doc(CONSUMER, [
            { contract: 'catalog-api/admin-rest-v1', ecosystem: ECO, builtAgainst: '3.0.0' },
          ])
        : doc(PROVIDER, []),
  }),
  putInterface: async (tx: unknown, input: { revision: number }, document: unknown) => {
    state.writes.push(['interface', tx, { revision: input.revision, document }]);
    return { revision: input.revision, updatedBy: 'u1', updatedAt: new Date(), document };
  },
}));
vi.mock('./contract/store.js', async (orig) => ({
  ...(await orig<object>()),
  versionsOf: async () => state.versions,
}));
vi.mock('./link-store.js', async (orig) => ({
  ...(await orig<object>()),
  linksWhere: async () => state.links,
  replaceLink: async (tx: unknown, input: { id: string; doc: { pinnedVersion: string } }) => {
    state.writes.push(['link', tx, { id: input.id, pinnedVersion: input.doc.pinnedVersion }]);
    return {};
  },
}));
vi.mock('./interface-service.js', async (orig) => ({
  ...(await orig<object>()),
  buildWorld: async () => ({}),
}));
vi.mock('./interface-rules.js', async (orig) => ({
  ...(await orig<object>()),
  checkInterface: () => state.interfaceRefusals,
}));

const { adoptVersion } = await import('./adopt-service.js');

const adopt = () =>
  adoptVersion({
    projectId: CONSUMER,
    writer: { userId: 'u1', agency: 'agent' },
    contract: 'catalog-api/admin-rest-v1',
    version: '3.1.1',
  });

describe('adopt writes the interface and every link in one transaction', () => {
  beforeEach(() => {
    state.held = true;
    state.writes = [];
    state.interfaceRefusals = [];
    state.versions = [
      version('3.1.1', '3.1.0', 'non-breaking'),
      version('3.1.0', '3.0.0', 'non-breaking'),
      version('3.0.0', null, 'initial'),
    ];
    state.links = [linkRow('l1', '3.0.0'), linkRow('l2', '3.0.0'), linkRow('l3', '3.1.1')];
  });

  it('moves builtAgainst and each link below the version, in the one transaction, and names the stale requirements', async () => {
    const out = await adopt();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(state.writes.every(([, tx]) => JSON.stringify(tx) === JSON.stringify(TX))).toBe(true);
    expect(state.writes.filter(([k]) => k === 'link').map(([, , w]) => w)).toEqual([
      { id: 'l1', pinnedVersion: '3.1.1' },
      { id: 'l2', pinnedVersion: '3.1.1' },
    ]);
    const [iface] = state.writes.filter(([k]) => k === 'interface');
    expect(iface?.[2]).toMatchObject({
      revision: 8,
      document: { consumes: [{ contract: 'catalog-api/admin-rest-v1', builtAgainst: '3.1.1' }] },
    });
    expect(out.held.revision).toBe(8);
    expect(out.moved.links.map((l) => l.id)).toEqual(['l1', 'l2']);
    expect(out.staleRequirements.map((r) => r.requirement)).toEqual(['REQ-1']);
  });

  it('writes nothing when a step is breaking', async () => {
    state.versions = [
      version('3.1.1', '3.1.0', 'non-breaking'),
      version('3.1.0', '3.0.0', 'breaking'),
      version('3.0.0', null, 'initial'),
    ];
    const out = await adopt();
    expect(out.ok ? [] : out.refusals.map((r) => r.code)).toEqual(['ADOPT_VERSION_BREAKING']);
    expect(state.writes).toEqual([]);
  });

  it('writes nothing when the moved consumption no longer passes the interface rules, and ignores drift elsewhere', async () => {
    state.interfaceRefusals = [
      { code: 'ECOSYSTEM_NOT_SHARED', path: '/consumes/0/ecosystem', detail: 'left' },
    ];
    const out = await adopt();
    expect(out.ok ? [] : out.refusals.map((r) => r.code)).toEqual(['ECOSYSTEM_NOT_SHARED']);
    expect(state.writes).toEqual([]);
    state.interfaceRefusals = [
      {
        code: 'RESPONSE_WINDOW_EXCEEDS_ECOSYSTEM',
        path: '/commitments/responseDays/rfi',
        detail: 'x',
      },
    ];
    expect((await adopt()).ok).toBe(true);
  });

  it("refuses a writer without the consumer's project.write, before reading anything", async () => {
    state.held = false;
    const out = await adopt();
    expect(out.ok ? [] : out.refusals.map((r) => r.code)).toEqual(['PERMISSION_FORBIDDEN']);
    expect(state.writes).toEqual([]);
  });
  it('moves a link the consumer holds in another ecosystem too, and refuses one pinned past the version', async () => {
    state.links = [linkRow('l1', '3.0.0'), linkRow('b1', '3.1.0', OTHER_ECO)];
    const out = await adopt();
    expect(out.ok && out.moved.links.map((l) => l.id)).toEqual(['l1', 'b1']);
    state.writes = [];
    state.links = [linkRow('l1', '3.0.0'), linkRow('b2', '3.2.0', OTHER_ECO)];
    const refused = await adopt();
    expect(refused.ok ? [] : refused.refusals.map((r) => r.code)).toEqual([
      'ADOPT_VERSION_BEHIND_PIN',
    ]);
    expect(state.writes).toEqual([]);
  });
});
