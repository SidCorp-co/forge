// ISS-1135 (FB-580): a breaking approval files a consumer's upgrade item only where a breaking entry
// reaches what its links record. Planted red first: on admin-api-v1 14.0.0, which broke only an
// operation catalog-api never calls, the approval filed catalog-api an item all the same.
//
// @direct-test-of packages/core/src/ecosystem/contract/announce.ts

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../../outbox/index.js', () => ({ emitEvent: async () => {} }));
vi.mock('../../lib/data-egress.js', () => ({ dataPolicyOf: async () => 'off' }));
vi.mock('../interface-store.js', () => ({
  consumersOf: async () => [
    { consumerId: 'catalog-api', consumerSlug: 'catalog-api', contractSlug: 'admin-api-v1' },
  ],
}));
const SITE = { operation: 'GET /api/v1/product-types', path: 'src/admin/types.ts', line: 12 };
vi.mock('../link-store.js', () => ({
  linksWhere: async () => [
    { id: 'b1db64d8', providerProjectId: 'admin', contractSlug: 'admin-api-v1' },
  ],
}));
vi.mock('../link-service.js', () => ({
  impactLink: (row: { id: string }) => ({
    id: row.id,
    consumer: 'catalog-api',
    module: 'src/admin',
    pinnedVersion: '13.0.0',
    callSites: [SITE],
    fieldsUsed: [],
    outsideContract: [],
  }),
}));
const filed: { weighed: { lead: string; entries: readonly string[] } }[] = [];
vi.mock('../../feedback/index.js', () => ({
  fileContractChangeIn: async (_tx: unknown, f: (typeof filed)[number]) => {
    filed.push(f);
    return { id: `fb-${filed.length}`, created: true };
  },
}));

const { fileBreakingIn } = await import('./announce.js');

const approved = (element: string) =>
  ({
    provider: { id: 'admin', slug: 'admin' },
    versioning: 'semver',
    noticeDays: 30,
    filer: { userId: 'u1', agency: 'human' },
    version: {
      contractSlug: 'admin-api-v1',
      version: '14.0.0',
      decidedAt: new Date('2026-11-06T00:00:00Z'),
      document: {
        diff: {
          classification: 'breaking',
          changes: [{ element, level: 'breaking', kind: 'removed', text: `${element} was removed` }],
        },
      },
    },
  }) as never;

describe('a breaking approval weighs each consumer before it files', () => {
  it('files nothing where the breaking entry is an operation the link never calls', async () => {
    filed.length = 0;
    expect(await fileBreakingIn({} as never, approved('DELETE /api/v1/stores/{id}'))).toEqual([]);
    expect(filed).toEqual([]);
  });

  it('files one naming the entry and the recorded call site it reaches', async () => {
    filed.length = 0;
    expect(await fileBreakingIn({} as never, approved('GET /api/v1/product-types'))).toEqual([
      'fb-1',
    ]);
    expect(filed[0]?.weighed.entries).toEqual([
      'GET /api/v1/product-types: GET /api/v1/product-types was removed (reaches GET /api/v1/product-types at src/admin/types.ts:12)',
    ]);
  });
});
