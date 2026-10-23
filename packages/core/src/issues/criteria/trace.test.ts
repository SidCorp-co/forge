import { describe, expect, it } from 'vitest';
import { strayTraceTagsOf, traceTagOf } from './criteria-text.js';
import { droppedTraces } from './match.js';

// Why REQ-25 BC-1 and BC-2 read "no issue traces here" while ISS-39 closed proving them: on
// 2026-10-06 its criteria were rewritten through the text path, which retired the three traced rows
// and added nineteen untraced ones, and nothing said the proof was gone. A write that drops a trace
// it does not restate is now refused by name; a plan's `(REQ-n BC-m)` lead is read as the trace.

const BC1 = 'rc-bc1';
const BC2 = 'rc-bc2';
const BC7 = 'rc-bc7';
const codeOf = new Map([
  [BC1, 'REQ-25 BC-1'],
  [BC2, 'REQ-25 BC-2'],
  [BC7, 'REQ-25 BC-7'],
]);
const dropped = (live: typeof iss39Before, desired: Parameters<typeof droppedTraces>[1]) =>
  droppedTraces(live, desired, codeOf);

const iss39Before = [
  { n: 1, statement: 'Mọi màn hình kiểm tra quyền theo vai trò.', requirementCriterionId: BC1 }, // i18n-allow: Vietnamese criterion under test
  {
    n: 2,
    statement: 'Dữ liệu nhạy cảm chỉ mở cho vai trò được phép.', // i18n-allow: Vietnamese criterion under test
    requirementCriterionId: BC2,
  },
  {
    n: 3,
    statement: 'Tên và số điện thoại chỉ hiện cho sáu vai trò.', // i18n-allow: Vietnamese criterion under test
    requirementCriterionId: BC7,
  },
];

describe('a criteria write that would drop a trace', () => {
  it('names every BC the ISS-39 rewrite would leave unproven', () => {
    const rewrite = Array.from({ length: 19 }, (_, i) => ({
      n: i + 1,
      statement: `English criterion ${i + 1}`,
    }));
    expect(dropped(iss39Before, rewrite)).toEqual([
      { n: 1, code: 'REQ-25 BC-1' },
      { n: 2, code: 'REQ-25 BC-2' },
      { n: 3, code: 'REQ-25 BC-7' },
    ]);
  });

  it('drops nothing where the rewrite restates each trace', () => {
    const rewrite = [
      { n: 1, statement: 'Every screen checks the role.', requirementCriterionId: BC1 },
      { n: 2, statement: 'Sensitive data opens to allowed roles.', requirementCriterionId: BC2 },
      { n: 3, statement: 'Name and phone show to six roles.', requirementCriterionId: BC7 },
      { n: 4, statement: 'A new criterion.' },
    ];
    expect(dropped(iss39Before, rewrite)).toEqual([]);
  });

  it('keeps the trace of a criterion whose words did not change', () => {
    const rewrite = [
      ...iss39Before.map(({ n, statement }) => ({ n, statement })),
      { n: 4, statement: 'More.' },
    ];
    expect(dropped(iss39Before, rewrite)).toEqual([]);
  });

  it('keeps the trace of a criterion that only moved to another number (ISS-567)', () => {
    const rewrite = [
      { n: 1, statement: 'A new first criterion.' },
      ...iss39Before.map(({ n, statement }) => ({ n: n + 1, statement })),
    ];
    expect(dropped(iss39Before, rewrite)).toEqual([]);
  });

  it('lets a writer who states every trace drop one on purpose', () => {
    const rewrite = [
      { n: 1, statement: 'Every screen checks the role.', requirementCriterionId: BC1 },
      { n: 2, statement: 'Out of scope now.', requirementCriterionId: null },
    ];
    expect(dropped(iss39Before, rewrite)).toEqual([]);
  });
});

// catalog-api ISS-3: the reworded line lost BC-3 while another line still traced it, and a count of
// BCs read nothing dropped; the lines are counted per BC.
describe('a reworded line whose BC another line still traces', () => {
  const iss3 = [
    { n: 1, statement: 'Lists products.', requirementCriterionId: BC1 },
    { n: 2, statement: 'Shows a price.', requirementCriterionId: BC7 },
    { n: 3, statement: 'Shows the site currency.', requirementCriterionId: BC7 },
  ];

  it('names that line and only it', () => {
    const rewrite = [
      { n: 1, statement: 'Lists products.' },
      { n: 2, statement: 'Shows a price.' },
      { n: 3, statement: 'Shows the currency it sells in.' },
    ];
    expect(dropped(iss3, rewrite)).toEqual([{ n: 3, code: 'REQ-25 BC-7' }]);
  });

  it('drops nothing where the reworded line restates the trace', () => {
    const rewrite = [
      { n: 1, statement: 'Lists products.' },
      { n: 2, statement: 'Shows a price.' },
      { n: 3, statement: 'Shows the currency it sells in.', requirementCriterionId: BC7 },
    ];
    expect(dropped(iss3, rewrite)).toEqual([]);
  });

  it('counts a trace to another wording of the same BC as kept', () => {
    const live = [{ n: 1, statement: 'Old words.', requirementCriterionId: 'rc-bc7-r1' }];
    const codes = new Map([...codeOf, ['rc-bc7-r1', 'REQ-25 BC-7']]);
    expect(
      droppedTraces(live, [{ n: 1, statement: 'New words.', requirementCriterionId: BC7 }], codes),
    ).toEqual([]);
    expect(droppedTraces(live, [{ n: 1, statement: 'New words.' }], codes)).toEqual([
      { n: 1, code: 'REQ-25 BC-7' },
    ]);
  });

  it('loses nothing where the trace is no proof to lose', () => {
    const live = [{ n: 1, statement: 'Old words.', requirementCriterionId: 'rc-retired' }];
    expect(dropped(live, [{ n: 1, statement: 'New words.' }])).toEqual([]);
  });
});

describe("a plan's trace tag", () => {
  it('reads a lead (REQ-n BC-m) as the BC the criterion proves', () => {
    expect(traceTagOf('(REQ-25 BC-1) `hop-access-decision` has one decision step.')).toEqual({
      kind: 'tag',
      requirementSeq: 25,
      code: 'BC-1',
    });
  });

  it('reads a statement with no lead tag as stating no trace', () => {
    expect(traceTagOf('The summary names, for each of REQ-26 BC-1 to BC-8, its steps.')).toEqual({
      kind: 'none',
    });
  });

  it('calls a tag naming two BCs malformed: one criterion proves one BC', () => {
    expect(
      traceTagOf('(REQ-22 BC-6, BC-8) Create, edit and submit require the permission.'),
    ).toEqual({
      kind: 'malformed',
      tag: '(REQ-22 BC-6, BC-8)',
    });
  });

  it('calls a lead tag in lowercase or with inner spaces malformed, never a guess (ISS-625)', () => {
    expect(traceTagOf('(req-48 bc-5) Something holds.')).toEqual({
      kind: 'malformed',
      tag: '(req-48 bc-5)',
    });
    expect(traceTagOf('( REQ-48 BC-5 ) Something holds.').kind).toBe('malformed');
  });
});

// ISS-625 (FB-230): a tag after the start of the line traced nothing and was stored in silence.
describe('a BC tag after the start of the line', () => {
  it.each([
    ['trailing', 'Something holds (REQ-48 BC-5)', ['(REQ-48 BC-5)']],
    ['mid-line', 'Something (REQ-48 BC-5) holds', ['(REQ-48 BC-5)']],
    ['lowercase', 'Something holds (req-48 bc-5)', ['(req-48 bc-5)']],
    ['second of two', '(REQ-48 BC-5) Something holds (REQ-48 BC-6)', ['(REQ-48 BC-6)']],
    ['two codes', 'Holds (REQ-22 BC-6, BC-8)', ['(REQ-22 BC-6, BC-8)']],
  ])('is found when %s', (_, statement, found) => {
    expect(strayTraceTagsOf(statement)).toEqual(found);
  });

  it.each([
    ['a lead tag', '(REQ-48 BC-5) Something holds'],
    ['an indented lead tag', '  (REQ-48 BC-5) Something holds'],
    ['a malformed lead tag, refused on its own', '(REQ-22 BC-6, BC-8) Holds'],
    ['a requirement in prose', 'Holds as REQ-6 says'],
    ['a BC in prose', 'Holds per REQ-48 BC-5, read in prose'],
    ['a requirement with no BC', 'Holds (REQ-6) too'],
  ])('is not found in %s', (_, statement) => {
    expect(strayTraceTagsOf(statement)).toEqual([]);
  });
});
