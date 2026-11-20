import { describe, expect, it } from 'vitest';
import { cleanCriteriaText, parseCriteriaText } from './criteria-text.js';

// ISS-1378 (forge-plugin ISS-117): a `Scope:` line above `1.` was dropped with no fault, the rows were
// written and the raw text kept, so every reader of the text that refuses an unnumbered line refused
// the issue for good once its criteria locked.

describe('a line before the first numbered criterion', () => {
  it('is a fault quoting the line and saying where it goes', () => {
    const parsed = parseCriteriaText('Scope: the order list only\n1. The list loads in 2 s.');
    expect(parsed.criteria).toEqual([]);
    expect(parsed.faults).toHaveLength(1);
    const [fault] = parsed.faults;
    expect(fault?.n).toBeNull();
    expect(fault?.why).toContain('"Scope: the order list only"');
    expect(fault?.why).toContain('number it');
    expect(fault?.why).toContain('description');
  });

  it('names the first such line and counts the rest', () => {
    const parsed = parseCriteriaText('Scope: one\nNotes: two\n\n1. It holds.');
    expect(parsed.faults).toHaveLength(1);
    expect(parsed.faults[0]?.why).toContain('"Scope: one"');
    expect(parsed.faults[0]?.why).toContain('1 more line');
  });

  it('is no fault where the lines above are blank', () => {
    const parsed = parseCriteriaText('\n   \n1. It holds.');
    expect(parsed.faults).toEqual([]);
    expect(parsed.criteria).toEqual([{ n: 1, statement: 'It holds.' }]);
  });

  it('leaves an indented continuation under a criterion its own', () => {
    const parsed = parseCriteriaText('1. The list loads\n    in under 2 s.\n2. A clerk sees it.');
    expect(parsed.faults).toEqual([]);
    expect(parsed.criteria).toEqual([
      { n: 1, statement: 'The list loads\nin under 2 s.' },
      { n: 2, statement: 'A clerk sees it.' },
    ]);
  });

  it('leaves text with no numbered line at all as unnumbered, not faulted', () => {
    const parsed = parseCriteriaText('The list loads fast.');
    expect(parsed.faults).toEqual([]);
    expect(parsed.unnumbered).toBe(true);
  });
});

describe('the criteria text a read serves', () => {
  const rows = [
    { n: 1, statement: 'The list loads in 2 s.' },
    { n: 2, statement: 'A clerk sees it.' },
  ];

  it('is the rows rendered where the stored text has a prose lead line', () => {
    expect(
      cleanCriteriaText('Scope: x\n1. The list loads in 2 s.\n2. A clerk sees it.', rows),
    ).toBe('1. The list loads in 2 s.\n2. A clerk sees it.');
  });

  it('is the stored text where it parses cleanly', () => {
    const stored = '1. The list loads in 2 s.\n2.  A clerk sees it.';
    expect(cleanCriteriaText(stored, rows)).toBe(stored);
  });

  it('is the stored text where no row stands to render', () => {
    expect(cleanCriteriaText('Scope: x\n1. y', [])).toBe('Scope: x\n1. y');
    expect(cleanCriteriaText(null, rows)).toBeNull();
  });
});
