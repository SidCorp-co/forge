// ISS-1135 (FB-580, catalog-api 2026-11-06 to 08): admin-api-v1 14.0.0, 15.0.0 and 16.0.0 each broke
// only operations catalog-api's link b1db64d8 never calls, and each drafted an upgrade item its master
// answered "no upgrade issue needed". A breaking version is weighed against what each consumer's links
// record before anything is drafted.
//
// @direct-test-of packages/core/src/ecosystem/contract/impact.ts

import { describe, expect, it } from 'vitest';
import { type ImpactChange, type ImpactLink, upgradeOwed, upgradeWords } from './impact.js';

const LINK: ImpactLink = {
  id: 'b1db64d8',
  consumer: 'catalog-api',
  module: 'src/admin',
  pinnedVersion: '13.0.0',
  callSites: [
    { operation: 'GET /api/v1/product-types', path: 'src/admin/types.ts', line: 12 },
    {
      operation: 'GET /api/v1/product-types/{product_type_id}',
      path: 'src/admin/types.ts',
      line: 40,
    },
  ],
  fieldsUsed: [],
  outsideContract: [],
};

const broke = (element: string): ImpactChange => ({
  element,
  level: 'breaking',
  kind: 'removed',
  text: `${element} was removed`,
});
const measured = (...changes: ImpactChange[]) => ({
  classification: 'breaking' as const,
  changes,
});

describe('a breaking version owes a consumer an upgrade item only where it reaches what the links record', () => {
  it('owes nothing where every breaking entry is an operation the link never calls', () => {
    const owed = upgradeOwed('semver', '14.0.0', measured(broke('DELETE /api/v1/stores/{id}')), [
      LINK,
    ]);
    expect(owed).toEqual({ owed: false, links: ['b1db64d8'] });
  });

  it('owes one naming the entry and the recorded call site it reaches', () => {
    const owed = upgradeOwed(
      'semver',
      '14.0.0',
      measured(broke('DELETE /api/v1/stores/{id}'), broke('GET /api/v1/product-types')),
      [LINK],
    );
    expect(owed).toMatchObject({ owed: true, why: 'touched' });
    if (!owed.owed) throw new Error('owed');
    const words = upgradeWords(owed, []);
    expect(words.entries).toEqual([
      'GET /api/v1/product-types: GET /api/v1/product-types was removed (reaches GET /api/v1/product-types at src/admin/types.ts:12)',
    ]);
  });

  it('owes one where a link records no call site, saying that is why', () => {
    const bare = { ...LINK, callSites: [] };
    const owed = upgradeOwed('semver', '14.0.0', measured(broke('DELETE /api/v1/stores/{id}')), [
      bare,
    ]);
    expect(owed).toEqual({ owed: true, why: 'unrecorded' });
    if (!owed.owed) throw new Error('owed');
    const breaking = [{ element: 'DELETE /api/v1/stores/{id}', text: 'removed' }];
    expect(upgradeWords(owed, breaking)).toEqual({
      lead: expect.stringContaining('records no call site or field'),
      entries: ['DELETE /api/v1/stores/{id}: removed'],
    });
  });

  it('owes one where the consumer holds no link, or nothing measured the version', () => {
    expect(upgradeOwed('semver', '14.0.0', measured(), [])).toEqual({
      owed: true,
      why: 'unlinked',
    });
    expect(upgradeOwed('semver', '14.0.0', null, [LINK])).toEqual({
      owed: true,
      why: 'unmeasured',
    });
  });
});
