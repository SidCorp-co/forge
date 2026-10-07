import { draftIssuesToPromote } from '@forge/contracts/requirements';
import { describe, expect, it } from 'vitest';
import { promoteSelection } from './promote-drafts.js';

const linked = [
  { id: 'a1', displayId: 'ISS-1', status: 'draft' },
  { id: 'b2', displayId: 'ISS-2', status: 'open' },
  { id: 'c3', displayId: 'ISS-3', status: 'draft' },
];

const select = (over: Partial<Parameters<typeof promoteSelection>[0]> = {}) =>
  promoteSelection({ status: 'agreed', key: 'REQ-4', linked, named: undefined, ...over });

describe('the drafts a promote moves', () => {
  it('takes every linked draft when none is named, in order', () => {
    expect(select()).toEqual({ ok: true, drafts: [linked[0], linked[2]] });
  });

  it('takes the named drafts by key or uuid, case aside, each once', () => {
    expect(select({ named: ['iss-3', 'C3', 'a1'] })).toEqual({
      ok: true,
      drafts: [linked[2], linked[0]],
    });
  });

  it('refuses each named issue not linked or not at draft, at its place in the request', () => {
    const picked = select({ named: ['ISS-1', 'ISS-2', 'ISS-9'] });
    expect(picked.ok).toBe(false);
    if (picked.ok) return;
    expect(picked.refusals.map((r) => `${r.code} ${r.path}`)).toEqual([
      'REQUIREMENT_ISSUE_NOT_DRAFT /issues/1',
      'REQUIREMENT_ISSUE_NOT_LINKED /issues/2',
    ]);
  });

  it('refuses when nothing is at draft', () => {
    const picked = select({ linked: [linked[1] as (typeof linked)[number]] });
    expect(picked).toMatchObject({
      ok: false,
      refusals: [{ code: 'REQUIREMENT_NO_DRAFT_ISSUES' }],
    });
  });

  it.each([
    ['deferred', 'REQUIREMENT_DEFERRED'],
    ['draft', 'REQUIREMENT_NOT_AGREED'],
    ['dropped', 'REQUIREMENT_NOT_AGREED'],
  ] as const)('refuses a %s requirement', (status, code) => {
    expect(select({ status })).toMatchObject({ ok: false, refusals: [{ code }] });
  });

  it('reads the same drafts the waiting line counts', () => {
    for (const status of ['agreed', 'accepted', 'deferred', 'draft'] as const) {
      const picked = select({ status });
      const counted = draftIssuesToPromote(status, linked);
      expect(picked.ok ? picked.drafts : []).toEqual(counted);
    }
  });
});
