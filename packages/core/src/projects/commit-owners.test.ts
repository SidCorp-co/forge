import { describe, expect, it } from 'vitest';
import { declaredIssueSeqs, issueRefPattern } from './commit-owners.js';

const ISS = issueRefPattern(['ISS']);
const declared = (subject: string) => declaredIssueSeqs(subject, ISS, 'staging');

// ISS-1445 (sidpeak FB-845): e45996c9 "merge: ISS-46/47/48 — …" stamped ISS-46 alone, because a
// list of keys was read only as whole keys and the bare numbers after the first were dropped.
describe('declaredIssueSeqs: a key carries the bare numbers `/` joins to it', () => {
  it('reads every issue a subject names under one prefix', () => {
    expect(
      declared(
        'merge: ISS-46/47/48 — dashboard nav labels, turnover chart fix, department rollup (FB-34/35/36)',
      ),
    ).toEqual([46, 47, 48]);
    expect(declared('fix(ui): add the rollup (ISS-46/47)')).toEqual([46, 47]);
    expect(declared('ISS-46/47 and ISS-50: the dashboard')).toEqual([46, 47, 50]);
  });

  it('reads a bare number after any other separator, or one running into text, as no key', () => {
    expect(declared('fix(ui): ISS-12, 3 files tidied')).toEqual([12]);
    expect(declared('fix(ui): ISS-12/3rd pass')).toEqual([12]);
    expect(declared('fix(ui): the chart, see ISS-46/47')).toEqual([]);
  });
});
