import { describe, expect, it } from 'vitest';
import { datedAhead } from './dated-ahead.js';

const WRITTEN = new Date('2026-10-07T22:54:08Z');

describe('a record that dates itself ahead', () => {
  it('flags a first-line stamp later than the record was written, with the time it states', () => {
    expect(
      datedAhead('**Decision (master, 2026-10-08 23:00Z): the design was returned.**', WRITTEN),
    ).toBe('2026-10-08T23:00:00.000Z');
  });

  it('keeps a stamp at or before the moment it was written, and one inside clock skew', () => {
    expect(datedAhead('**Decision (master, 2026-10-07 22:50Z): folded.**', WRITTEN)).toBeNull();
    expect(datedAhead('**Decision (master, 2026-10-07 22:58Z): folded.**', WRITTEN)).toBeNull();
  });

  it('reads a zone offset, and a bare date or hour in the latest zone a writer may be in', () => {
    expect(datedAhead('(master, 2026-10-08 05:00+07:00) passed over', WRITTEN)).toBeNull();
    expect(datedAhead('(master, 2026-10-08) passed over', WRITTEN)).toBeNull();
    expect(datedAhead('(master, 2026-10-09) passed over', WRITTEN)).toBe(
      '2026-10-09T00:00:00.000Z',
    );
  });

  it('reads only a bracketed stamp on the first line', () => {
    expect(datedAhead('We launch referrals on 2099-01-01.', WRITTEN)).toBeNull();
    expect(datedAhead('Folded.\n(master, 2099-01-01 10:00Z)', WRITTEN)).toBeNull();
  });
});
