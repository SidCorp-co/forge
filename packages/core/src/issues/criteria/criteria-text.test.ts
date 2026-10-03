import { describe, expect, it } from 'vitest';
import { normalizeStatement, parseCriteriaText, renderCriteriaText } from './criteria-text.js';

describe('parseCriteriaText (ISS-55: the text dual path and the backfill)', () => {
  it('reads each numbered line, with the lines under it, in order', () => {
    const parsed = parseCriteriaText('Criteria:\n1. First\n   wrapped on.\n2. Second\n10. Tenth');
    expect(parsed.faults).toEqual([]);
    expect(parsed.criteria).toEqual([
      { n: 1, statement: 'First\nwrapped on.' },
      { n: 2, statement: 'Second' },
      { n: 10, statement: 'Tenth' },
    ]);
  });

  it('does not mint a criterion from an indented continuation', () => {
    expect(parseCriteriaText('1. One\n    2. not a criterion').criteria.map((c) => c.n)).toEqual([
      1,
    ]);
  });

  it('refuses a number written twice, and writes no criterion at all', () => {
    const parsed = parseCriteriaText('1. a\n1. b');
    expect(parsed.criteria).toEqual([]);
    expect(parsed.faults).toEqual([{ n: 1, why: 'criterion 1 is numbered twice' }]);
  });

  it('refuses a number with no statement and a number below 1', () => {
    expect(parseCriteriaText('1. \n2. b').faults[0]?.why).toBe('criterion 1 has no statement');
    expect(parseCriteriaText('0. zero').faults[0]?.why).toBe('criterion 0 is numbered below 1');
  });

  it('says a text with words and no numbered line is unnumbered, and empty text is not', () => {
    expect(parseCriteriaText('- a bullet\n- another').unnumbered).toBe(true);
    expect(parseCriteriaText('').unnumbered).toBe(false);
    expect(parseCriteriaText(null).criteria).toEqual([]);
  });

  it('renders text that reads back as the same criteria', () => {
    const criteria = [
      { n: 1, statement: 'One\n2. still one' },
      { n: 3, statement: 'Three' },
    ];
    expect(parseCriteriaText(renderCriteriaText(criteria)).criteria).toEqual(criteria);
  });

  it('treats a re-wrapped statement as the same criterion', () => {
    expect(normalizeStatement('a\n  b   c ')).toBe(normalizeStatement('a b c'));
  });
});
