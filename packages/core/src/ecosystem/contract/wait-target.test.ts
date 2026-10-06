import { describe, expect, it } from 'vitest';
import { contractVersionReads } from './version-read.js';
import { waitTargetOf } from './wait-target.js';
import { contractWaitTargetIn } from './waits.js';

const now = new Date('2026-10-06T12:00:00Z');
const facts = {
  known: ['catalog-api/admin-rest-v1'],
  provider: { id: 'prov-1', slug: 'catalog-api' },
  versioning: 'semver' as const,
};
const wait = (over: Record<string, string> = {}) => ({
  projectId: 'p1',
  contract: 'catalog-api/admin-rest-v1',
  minVersion: '3.1.0',
  ...over,
});
const codes = (out: ReturnType<typeof waitTargetOf>) =>
  out.ok ? [] : out.refusals.map((r) => [r.code, r.path]);

describe('one check refuses a wait wherever it is written', () => {
  it('resolves a consumed contract at a version in the scheme', () => {
    expect(waitTargetOf(wait({ dueAt: '2026-11-01T00:00:00Z' }), facts, now)).toEqual({
      ok: true,
      value: {
        contract: 'catalog-api/admin-rest-v1',
        providerProjectId: 'prov-1',
        providerSlug: 'catalog-api',
        contractSlug: 'admin-rest-v1',
        minVersion: '3.1.0',
        dueAt: new Date('2026-11-01T00:00:00Z'),
      },
    });
  });

  it('refuses a contract the interface does not name', () => {
    expect(codes(waitTargetOf(wait({ contract: 'catalog-api/other' }), facts, now))).toEqual([
      ['CONTRACT_WAIT_CONTRACT_UNKNOWN', '/contract'],
    ]);
  });

  it('refuses a version outside the provider scheme, and any version without one', () => {
    expect(codes(waitTargetOf(wait({ minVersion: 'v3' }), facts, now))).toEqual([
      ['CONTRACT_WAIT_VERSION_NOT_IN_SCHEME', '/minVersion'],
    ]);
    expect(codes(waitTargetOf(wait(), { ...facts, versioning: null }, now))).toEqual([
      ['CONTRACT_WAIT_VERSION_NOT_IN_SCHEME', '/minVersion'],
    ]);
  });

  it('refuses a malformed or past deadline', () => {
    expect(codes(waitTargetOf(wait({ dueAt: 'friday' }), facts, now))).toEqual([
      ['CONTRACT_WAIT_DUE_MALFORMED', '/dueAt'],
    ]);
    expect(codes(waitTargetOf(wait({ dueAt: '2026-10-01T00:00:00Z' }), facts, now))).toEqual([
      ['CONTRACT_WAIT_DUE_PAST', '/dueAt'],
    ]);
  });

  it('is the check the port hands the breakdown guard', () => {
    expect(contractVersionReads.waitTargetIn).toBe(contractWaitTargetIn);
  });
});
