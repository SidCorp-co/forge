// A verdict's `criterion` as the criterion's exact line: the forms that name it, and the near misses
// that never do (no fuzzy match), each refused listing the issue's criteria.

import { describe, expect, it } from 'vitest';
import { criterionNamed, type NamedCriterion, numberCriteria } from './criterion-named.js';
import type { ForgeRecord } from './forge-record.js';

const CRITERIA: NamedCriterion[] = [
  { n: 1, statement: '(REQ-8 BC-1) A reload shows every saved card', trace: null },
  { n: 2, statement: 'The board keeps its order', trace: 'REQ-8 BC-2' },
];

describe('criterionNamed', () => {
  it.each([
    ['(REQ-8 BC-1) A reload shows every saved card', 1],
    ['1. (REQ-8 BC-1) A reload shows every saved card', 1],
    ['A reload shows every saved card', 1],
    ['  1.  A reload   shows every saved card ', 1],
    // a row traced by its field takes its tag back on the line
    ['(REQ-8 BC-2) The board keeps its order', 2],
    ['2. The board keeps its order', 2],
  ])('names criterion %s as %i', (text, n) => {
    expect(criterionNamed(text, CRITERIA)).toEqual({ n });
  });

  it.each([
    'A reload shows every saved cards',
    'a reload shows every saved card',
    '(REQ-8 BC-2) A reload shows every saved card',
    '2. A reload shows every saved card',
    'reload shows every saved card',
    '(REQ-8 BC-1)',
  ])('refuses %s, listing the criteria', (text) => {
    const named = criterionNamed(text, CRITERIA);
    expect('why' in named && named.why).toContain(
      'its criteria are 1 "A reload shows every saved card", 2 "The board keeps its order"',
    );
  });

  it('refuses a line two criteria share, naming both', () => {
    const twice = [...CRITERIA, { n: 3, statement: 'The board keeps its order', trace: null }];
    expect(criterionNamed('The board keeps its order', twice)).toEqual({
      why: '`The board keeps its order` is the line of criteria 2 and 3 alike; name the one judged by its number.',
    });
  });

  it('says so where the issue has no criteria', () => {
    const named = criterionNamed('A reload shows every saved card', []);
    expect('why' in named && named.why).toContain('this issue has no criteria yet');
  });
});

describe('numberCriteria', () => {
  const record = (criterion: string): ForgeRecord =>
    ({
      kind: 'verdict',
      contract: 1,
      fields: [
        { key: 'criterion', value: criterion, over: 0 },
        { key: 'verdict', value: 'pass', over: 0 },
      ],
      lead: null,
      absent: [],
      at: 0,
    }) as unknown as ForgeRecord;

  it('rewrites an exact line to its number and leaves a near miss as written', () => {
    expect(numberCriteria(record(CRITERIA[0]?.statement ?? ''), CRITERIA).fields[0]?.value).toBe(
      '1',
    );
    expect(numberCriteria(record('A reload shows cards'), CRITERIA).fields[0]?.value).toBe(
      'A reload shows cards',
    );
    expect(numberCriteria(record('2'), CRITERIA).fields[0]?.value).toBe('2');
  });
});
