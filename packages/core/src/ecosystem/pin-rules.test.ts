import { describe, expect, it } from 'vitest';
import { checkInterface, type InterfaceWorld, versionKey } from './interface-rules.js';
import { checkLink, type LinkWorld } from './link-rules.js';
import type { LinkWrite } from './link-schema.js';
import type { InterfaceDocument } from './schema.js';

const PROVIDER = '11111111-1111-4111-8111-111111111111';
const CONSUMER = '22222222-2222-4222-8222-222222222222';
const ECO = '33333333-3333-4333-8333-333333333333';
const SHA = 'a'.repeat(40);

// 3.1.0 waits on a decision and 2.9.0 was returned; only 3.0.0 is a version anyone builds against
const VERSIONS = new Map([
  ['2.9.0', 'returned'],
  ['3.0.0', 'approved'],
  ['3.1.0', 'proposed'],
]);

const publication = {
  title: 'Admin REST',
  type: 'openapi' as const,
  artifact: { upload: true as const },
  lifecycle: 'production' as const,
  ecosystems: [ECO],
};

const providerInterface = (consumes: InterfaceDocument['consumes'] = []): InterfaceDocument => ({
  $schema: 'https://forge.dev/schemas/interface-v1.json' as InterfaceDocument['$schema'],
  version: 1,
  project: PROVIDER,
  publishes: { 'admin-rest': publication },
  consumes,
  commitments: {
    versioning: 'semver',
    deprecationNoticeDays: 30,
    responseDays: { rfi: 5, 'change-request': 10 },
  },
});

const link = (pinnedVersion: string, consumer = CONSUMER): LinkWrite => ({
  $schema: 'https://forge.dev/schemas/link-v1.json' as LinkWrite['$schema'],
  version: 1,
  ...(consumer === PROVIDER ? {} : { ecosystem: ECO }),
  consumer: { project: consumer, module: 'apps/web' },
  contract: { provider: PROVIDER, slug: 'admin-rest' },
  pinnedVersion,
  state: 'building',
  callSites: [],
  fieldsUsed: [],
  outsideContract: [],
  notes: [],
  writtenBy: { sha: SHA },
  refreshedAtSha: SHA,
});

const linkWorld = (): LinkWorld => ({
  consumerSource: { type: 'repository' },
  consumerActiveIn: new Set([ECO]),
  provider: { id: PROVIDER, activeIn: new Set([ECO]), interface: providerInterface() },
  versions: VERSIONS,
  duplicateOf: null,
});

const interfaceWorld = (): InterfaceWorld => ({
  project: { id: PROVIDER, slug: 'catalog-api' },
  activeEcosystems: new Map(),
  providers: new Map(),
  versions: new Map([[versionKey(PROVIDER, 'admin-rest'), VERSIONS]]),
  elements: new Map(),
  consumersOfMine: [],
});

// the in-project consumption: the project's UI consuming its own contract, published in no ecosystem
const consuming = (builtAgainst: string): InterfaceDocument => ({
  ...providerInterface([{ contract: 'catalog-api/admin-rest', builtAgainst }]),
  publishes: { 'admin-rest': { ...publication, ecosystems: [] } },
});

describe('a consumer pins an approved contract version, never a proposed one', () => {
  it('refuses a link pinned to a proposed version, naming its state and the approved versions', () => {
    const refusals = checkLink(link('3.1.0'), linkWorld());
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      code: 'CONTRACT_VERSION_NOT_APPROVED',
      path: '/pinnedVersion',
    });
    expect(refusals[0]?.detail).toContain('"3.1.0" is proposed');
    expect(refusals[0]?.detail).toContain('approved: 3.0.0');
  });

  it('refuses a link pinned to a returned version', () => {
    const [refusal] = checkLink(link('2.9.0'), linkWorld());
    expect(refusal).toMatchObject({
      code: 'CONTRACT_VERSION_NOT_APPROVED',
      path: '/pinnedVersion',
    });
    expect(refusal?.detail).toContain('"2.9.0" is returned');
  });

  it('refuses the in-project link to the project own proposed version too', () => {
    const [refusal] = checkLink(link('3.1.0', PROVIDER), linkWorld());
    expect(refusal?.code).toBe('CONTRACT_VERSION_NOT_APPROVED');
  });

  it('accepts a link pinned to an approved version', () => {
    expect(checkLink(link('3.0.0'), linkWorld())).toEqual([]);
  });

  it('still refuses a version core never recorded as VERSION_UNKNOWN', () => {
    const [refusal] = checkLink(link('9.9.9'), linkWorld());
    expect(refusal?.code).toBe('VERSION_UNKNOWN');
  });

  it('names "none yet" when the contract has no approved version at all', () => {
    const world = { ...linkWorld(), versions: new Map([['3.1.0', 'proposed']]) };
    const [refusal] = checkLink(link('3.1.0'), world);
    expect(refusal?.code).toBe('CONTRACT_VERSION_NOT_APPROVED');
    expect(refusal?.detail).toContain('approved: none yet');
  });

  it('refuses a consumption built against a proposed version', () => {
    const refusals = checkInterface(consuming('3.1.0'), interfaceWorld());
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      code: 'CONTRACT_VERSION_NOT_APPROVED',
      path: '/consumes/0/builtAgainst',
    });
    expect(refusals[0]?.detail).toContain('approved: 3.0.0');
  });

  it('accepts a consumption built against an approved version', () => {
    expect(checkInterface(consuming('3.0.0'), interfaceWorld())).toEqual([]);
  });
});
