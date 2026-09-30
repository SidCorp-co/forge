import { describe, expect, it } from 'vitest';
import { entryRefusal } from './admit.mjs';

const head = 'a'.repeat(40);
const other = 'b'.repeat(40);
const member = (entry) => ({ issue: 'ISS-9', branch: 'ISS-9-x', head, entry });

describe('entryRefusal', () => {
  it('admits a member whose entry gate passed at its recorded head', () => {
    expect(entryRefusal(member({ at: head, record: 'ISS-9 comment 1a2b' }))).toBeNull();
  });

  it('refuses a member with no entry-gate record, naming the field', () => {
    expect(entryRefusal(member(undefined))).toBe(
      'ISS-9 carries no `entry`: a member enters only with the entry gate its own run passed, as `entry.at` (the commit) and `entry.record` (where that run recorded it)',
    );
  });

  it('refuses a record taken at another commit, naming both', () => {
    expect(entryRefusal(member({ at: other, record: 'ISS-9 comment 1a2b' }))).toBe(
      `ISS-9's entry gate passed at ${other} and the window recorded ${head}: a gate measured at another commit describes a tree that was never admitted`,
    );
  });

  it.each([
    [[], "ISS-9's `entry` is not an object of `at` and `record`"],
    [
      { at: head, record: '  ' },
      "ISS-9's `entry` carries no `record`, so nobody can read the entry gate it claims to have passed",
    ],
    [
      { at: 'abc1234', record: 'r' },
      "ISS-9's `entry.at` must be the full 40-character commit its entry gate passed at, not abc1234",
    ],
  ])('refuses the malformed record %j by name', (entry, want) => {
    expect(entryRefusal(member(entry))).toBe(want);
  });
});
