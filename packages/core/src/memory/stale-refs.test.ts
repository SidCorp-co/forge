import { describe, expect, it } from 'vitest';
import { toMemoryHit } from './search.js';
import { citedKeys, issuePrefixSet, staleRefsOf } from './stale-refs.js';

// MJ-3: a memory names records; the ones that no longer resolve are named back as why it reads
// stale, and a closed issue or a deferred requirement still resolves. MJ-5: a hit speaks as of its
// last write or confirmation, whichever is later.

const prefixes = issuePrefixSet({ active: null, held: [] });

describe('the records a memory cites', () => {
  it('reads issue keys under the prefixes the project answers to, and requirement keys, once each', () => {
    const cited = citedKeys('ISS-4 then REQ-2, ISS-4 again, HOP-9 and FB-3 (ISS-12)', prefixes);
    expect(cited.issues.map((i) => i.ref)).toEqual(['ISS-4', 'ISS-12']);
    expect(cited.requirements.map((r) => r.ref)).toEqual(['REQ-2']);
  });

  it('reads a renamed project under its active prefix and every one it held', () => {
    const p = issuePrefixSet({ active: 'HOP', held: ['HOP', 'HP'] });
    expect(citedKeys('HOP-1, HP-2, ISS-3', p).issues.map((i) => i.ref)).toEqual(['HOP-1', 'HP-2']);
  });

  it('names a missing, dropped or archived record, and passes a closed issue or deferred requirement', () => {
    const cited = citedKeys('ISS-1 ISS-2 ISS-3 ISS-4 REQ-1 REQ-2 REQ-3', prefixes);
    const refs = staleRefsOf(cited, {
      issues: new Map([
        [1, { status: 'closed', archived: false }],
        [2, { status: 'dropped', archived: false }],
        [3, { status: 'open', archived: true }],
      ]),
      requirements: new Map([
        [1, 'deferred'],
        [2, 'dropped'],
      ]),
    });
    expect(refs).toEqual([
      { ref: 'ISS-2', kind: 'issue', why: 'dropped' },
      { ref: 'ISS-3', kind: 'issue', why: 'archived' },
      { ref: 'ISS-4', kind: 'issue', why: 'missing' },
      { ref: 'REQ-2', kind: 'requirement', why: 'dropped' },
      { ref: 'REQ-3', kind: 'requirement', why: 'missing' },
    ]);
  });
});

describe('a memory hit is dated', () => {
  const row = {
    id: 'm',
    source: 'note',
    sourceRef: 'r',
    text: 't',
    metadata: {},
    embeddedAt: new Date('2026-10-07T00:00:00Z'),
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-03T00:00:00Z'),
  };

  it('speaks as of its last write when nobody confirmed it since', () => {
    const hit = toMemoryHit({ ...row, lastVerifiedAt: null }, 1);
    expect(hit.writtenAt.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(hit.asOf.toISOString()).toBe('2026-10-03T00:00:00.000Z');
    expect(hit.verifiedAt).toBeNull();
  });

  it('speaks as of its confirmation when that is later', () => {
    const hit = toMemoryHit({ ...row, lastVerifiedAt: new Date('2026-10-05T00:00:00Z') }, 1);
    expect(hit.asOf.toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });
});
