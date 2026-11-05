import { describe, expect, it } from 'vitest';
import { strayTraceTagsOf, traceTagOf } from './criteria-text.js';
import { droppedTraceDetail, droppedTraces } from './dropped-traces.js';
import { matchCriteria } from './match.js';

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

type Line = { n: number; statement: string; requirementCriterionId?: string | null };
type Row = { n: number; statement: string; requirementCriterionId: string | null };
const idOf = new Map([...codeOf].map(([id, code]) => [code, id]));

/** Each finding as `<line as sent> <BC>`, `removed <live line> <BC>` or `unclear <lines> <BC>`. */
const named = (live: readonly Row[], sent: readonly Line[]) =>
  dropped(live, sent).map((d) =>
    d.kind === 'line'
      ? `${d.line.n} ${d.code}`
      : d.kind === 'removed'
        ? `removed ${d.was.n} ${d.code}`
        : `unclear ${d.candidates.map((c) => c.n).join(',')} ${d.code}`,
  );

/** The trace each line holds once the write is taken, as `[n, BC]`: its own, or its kept row's. */
function stored(live: readonly Row[], sent: readonly Line[]): [number, string | null][] {
  const { kept } = matchCriteria(live, sent);
  return sent.map((c, i) => {
    const id =
      c.requirementCriterionId === undefined
        ? kept.get(i)?.requirementCriterionId
        : c.requirementCriterionId;
    return [c.n, (id && codeOf.get(id)) ?? null];
  });
}

/**
 * Apply the refusal's advice word for word, as a text writer would: open each line it names with the
 * tag it names (the store reads that lead tag as the trace, `store.ts:tracedInputs`), and put back each
 * removed line it names, tagged, at the end.
 */
function follow(live: readonly Row[], sent: readonly Line[], detail: string): Line[] {
  const out = sent.map((c) => ({ ...c }));
  for (const [, n, code] of detail.matchAll(/open criterion (\d+) with \((REQ-\d+ BC-\d+)\)/g)) {
    const line = out.find((c) => c.n === Number(n)) as Line;
    line.statement = `(${code}) ${line.statement}`;
    line.requirementCriterionId = idOf.get(code as string) ?? null;
  }
  for (const [, n, code] of detail.matchAll(
    /put live criterion (\d+) back, opening with \((REQ-\d+ BC-\d+)\)/g,
  )) {
    const was = live.find((r) => r.n === Number(n)) as Row;
    out.push({
      n: out.length + 1,
      statement: `(${code}) ${was.statement}`,
      requirementCriterionId: idOf.get(code as string) ?? null,
    });
  }
  return out;
}

describe('a criteria write that would drop a trace', () => {
  it('names every BC the ISS-39 rewrite would leave unproven, and guesses no line for it', () => {
    const rewrite = Array.from({ length: 19 }, (_, i) => ({
      n: i + 1,
      statement: `English criterion ${i + 1}`,
    }));
    const found = dropped(iss39Before, rewrite);
    expect(found.map((d) => [d.kind, d.code])).toEqual([
      ['unclear', 'REQ-25 BC-1'],
      ['unclear', 'REQ-25 BC-2'],
      ['unclear', 'REQ-25 BC-7'],
    ]);
    expect(found.every((d) => d.kind === 'unclear' && d.candidates.length === 19)).toBe(true);
    expect(droppedTraceDetail(found)).toContain('cannot be told from their words');
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
// BCs read nothing dropped; the lines are paired one by one.
describe('a reworded line whose BC another line still traces', () => {
  const iss3 = [
    { n: 1, statement: 'Lists products.', requirementCriterionId: BC1 },
    { n: 2, statement: 'Shows a price.', requirementCriterionId: BC7 },
    { n: 3, statement: 'Shows the site currency.', requirementCriterionId: BC7 },
  ];

  it('names that line as sent, with its new words and the live line it rewords', () => {
    const rewrite = [
      { n: 1, statement: 'Lists products.' },
      { n: 2, statement: 'Shows a price.' },
      { n: 3, statement: 'Shows the currency it sells in.' },
    ];
    expect(dropped(iss3, rewrite)).toEqual([
      {
        kind: 'line',
        code: 'REQ-25 BC-7',
        line: { n: 3, statement: 'Shows the currency it sells in.' },
        was: [{ n: 3, statement: 'Shows the site currency.' }],
        reworded: true,
      },
    ]);
    expect(droppedTraceDetail(dropped(iss3, rewrite))).toContain(
      'criterion 3 ("Shows the currency it sells in.") as sent rewords live criterion 3 ("Shows the site currency."), which proved REQ-25 BC-7, and does not carry it',
    );
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
    expect(
      droppedTraces(live, [{ n: 1, statement: 'New words.' }], codes).map((d) => d.kind),
    ).toEqual(['line']);
  });

  it('loses nothing where the trace is no proof to lose', () => {
    const live = [{ n: 1, statement: 'Old words.', requirementCriterionId: 'rc-retired' }];
    expect(dropped(live, [{ n: 1, statement: 'New words.' }])).toEqual([]);
  });

  it('names a kept line sent with another trace', () => {
    expect(
      named(iss3, [
        { n: 1, statement: 'Lists products.' },
        { n: 2, statement: 'Shows a price.', requirementCriterionId: BC2 },
        { n: 3, statement: 'Shows the site currency.' },
      ]),
    ).toEqual(['2 REQ-25 BC-7']);
  });
});

// ISS-673, K76 (dev.309): the refusal named lines by their old numbers, so where a line was inserted
// above a reworded traced one, it named the inserted line, and tagging that line was taken with the
// reworded one untraced. Each case below sends the write, follows the refusal word for word, and
// reads which line ends up holding the BC.
describe('the line a refusal names is the one the writer sent', () => {
  const plan: Row[] = [
    { n: 1, statement: 'A site lists its products', requirementCriterionId: BC1 },
    { n: 2, statement: 'A price shows in the site currency', requirementCriterionId: BC7 },
  ];

  it('a traced line reworded in place: names it, and following puts the BC on it', () => {
    const sent = [
      { n: 1, statement: 'A site lists its products' },
      { n: 2, statement: 'A price shows in the currency the site sells in' },
    ];
    expect(named(plan, sent)).toEqual(['2 REQ-25 BC-7']);
    const retry = follow(plan, sent, droppedTraceDetail(dropped(plan, sent)));
    expect(dropped(plan, retry)).toEqual([]);
    expect(stored(plan, retry)).toEqual([
      [1, 'REQ-25 BC-1'],
      [2, 'REQ-25 BC-7'],
    ]);
  });

  it('a traced line reworded and moved below an inserted line: names its new number, never the old', () => {
    const live: Row[] = [plan[1] as Row];
    const sent = [
      { n: 1, statement: 'Search narrows the list' },
      { n: 2, statement: 'A price shows in the currency the site sells in' },
    ].map((c, i) => ({ ...c, n: i + 1 }));
    const moved: Row[] = [{ ...(live[0] as Row), n: 1 }];
    expect(named(moved, sent)).toEqual(['2 REQ-25 BC-7']);
    const detail = droppedTraceDetail(dropped(moved, sent));
    expect(detail).toContain(
      'criterion 2 ("A price shows in the currency the site sells in") as sent rewords live criterion 1 ("A price shows in the site currency")',
    );
    expect(detail).not.toContain('open criterion 1 ');

    const retry = follow(moved, sent, detail);
    expect(dropped(moved, retry)).toEqual([]);
    expect(stored(moved, retry)).toEqual([
      [1, null],
      [2, 'REQ-25 BC-7'],
    ]);
  });

  it('refuses, naming the reworded line, a write that tags the inserted line instead (the dev.309 advice)', () => {
    const moved: Row[] = [{ ...(plan[1] as Row), n: 1 }];
    const wrong = [
      { n: 1, statement: '(REQ-25 BC-7) Search narrows the list', requirementCriterionId: BC7 },
      { n: 2, statement: 'A price shows in the currency the site sells in' },
    ];
    expect(named(moved, wrong)).toEqual(['2 REQ-25 BC-7']);
  });

  it('two lines on one BC with one dropping its tag (K65): names that line, and following converges', () => {
    const live: Row[] = [
      { n: 1, statement: 'A buyer sees the price', requirementCriterionId: BC7 },
      { n: 2, statement: 'A buyer sees the tax', requirementCriterionId: BC7 },
      { n: 3, statement: 'A buyer sees the total', requirementCriterionId: BC7 },
    ];
    const sent = [
      {
        n: 1,
        statement: '(REQ-25 BC-7) A buyer sees the price at checkout',
        requirementCriterionId: BC7,
      },
      { n: 2, statement: 'A buyer sees the tax at checkout' },
      {
        n: 3,
        statement: '(REQ-25 BC-7) A buyer sees the total at checkout',
        requirementCriterionId: BC7,
      },
    ];
    expect(named(live, sent)).toEqual(['2 REQ-25 BC-7']);
    const retry = follow(live, sent, droppedTraceDetail(dropped(live, sent)));
    expect(dropped(live, retry)).toEqual([]);
    expect(stored(live, retry).map(([, code]) => code)).toEqual(Array(3).fill('REQ-25 BC-7'));
  });

  it('a line deleted outright: names it as removed, and putting it back tagged keeps the BC on it', () => {
    const live: Row[] = [
      { n: 1, statement: 'A site lists its products', requirementCriterionId: BC1 },
      { n: 2, statement: 'A price shows in the site currency', requirementCriterionId: BC7 },
      { n: 3, statement: 'A cart holds the products', requirementCriterionId: BC2 },
    ];
    const sent = [
      { n: 1, statement: 'A site lists its products' },
      { n: 2, statement: 'A cart holds the products' },
      { n: 3, statement: 'Search narrows the list' },
    ];
    expect(named(live, sent)).toEqual(['removed 2 REQ-25 BC-7']);
    const detail = droppedTraceDetail(dropped(live, sent));
    expect(detail).toContain(
      'live criterion 2 ("A price shows in the site currency"), which proved REQ-25 BC-7, has no line in its place',
    );
    const retry = follow(live, sent, detail);
    expect(dropped(live, retry)).toEqual([]);
    expect(stored(live, retry)).toEqual([
      [1, 'REQ-25 BC-1'],
      [2, 'REQ-25 BC-2'],
      [3, null],
      [4, 'REQ-25 BC-7'],
    ]);
  });

  it('names every candidate, guessing none, where the words cannot tell which line carries it on', () => {
    const live: Row[] = [{ n: 1, statement: 'Prices are local', requirementCriterionId: BC7 }];
    const sent = [
      { n: 1, statement: 'Search narrows the list' },
      { n: 2, statement: 'Checkout takes a card' },
    ];
    expect(named(live, sent)).toEqual(['unclear 1,2 REQ-25 BC-7']);
    const detail = droppedTraceDetail(dropped(live, sent));
    expect(detail).toContain(
      'which of criteria 1 ("Search narrows the list") or 2 ("Checkout takes a card") as sent carries it on cannot be told from their words',
    );
    expect(detail).not.toMatch(/open criterion \d/);
    // the writer says which: the BC lands on the line they tagged, and nowhere else
    const chosen = [
      sent[0] as Line,
      { n: 2, statement: '(REQ-25 BC-7) Checkout takes a card', requirementCriterionId: BC7 },
    ];
    expect(dropped(live, chosen)).toEqual([]);
    expect(stored(live, chosen)).toEqual([
      [1, null],
      [2, 'REQ-25 BC-7'],
    ]);
  });

  it('names the one free line by its place where the words share nothing, but only one line is free', () => {
    const live: Row[] = [
      { n: 1, statement: 'Alpha', requirementCriterionId: BC7 },
      { n: 2, statement: 'Bravo', requirementCriterionId: BC7 },
      { n: 3, statement: 'Charlie', requirementCriterionId: BC7 },
    ];
    const sent = [
      { n: 1, statement: '(REQ-25 BC-7) Delta', requirementCriterionId: BC7 },
      { n: 2, statement: '(REQ-25 BC-7) Echo', requirementCriterionId: BC7 },
      { n: 3, statement: 'Foxtrot' },
    ];
    expect(named(live, sent)).toEqual(['3 REQ-25 BC-7']);
  });

  it('names a reworded line between two kept ones by its place, and no new line elsewhere', () => {
    const live: Row[] = [
      { n: 1, statement: 'Alpha', requirementCriterionId: BC1 },
      { n: 2, statement: 'Bravo', requirementCriterionId: BC7 },
      { n: 3, statement: 'Charlie', requirementCriterionId: BC2 },
    ];
    const sent = [
      { n: 1, statement: 'Zulu' },
      { n: 2, statement: 'Alpha' },
      { n: 3, statement: 'Delta' },
      { n: 4, statement: 'Charlie' },
    ];
    expect(named(live, sent)).toEqual(['3 REQ-25 BC-7']);
  });

  it('calls two BCs short in one place unclear, as which line takes which cannot be told', () => {
    const live: Row[] = [
      { n: 1, statement: 'Alpha', requirementCriterionId: BC1 },
      { n: 2, statement: 'Bravo', requirementCriterionId: BC7 },
    ];
    const sent = [
      { n: 1, statement: 'Delta' },
      { n: 2, statement: 'Echo' },
    ];
    expect(named(live, sent)).toEqual(['unclear 1,2 REQ-25 BC-1', 'unclear 1,2 REQ-25 BC-7']);
  });
});

// ISS-673 (K65): three lines on one BC reworded, two restating it; the refusal named a line that
// already carried the tag, so following it looped.
describe('several lines on one BC reworded, some restating it', () => {
  const k65 = [1, 2, 3].map((n) => ({ n, statement: `Old ${n}.`, requirementCriterionId: BC7 }));

  it('names the one line that dropped it', () => {
    const rewrite = [
      { n: 1, statement: 'New 1.', requirementCriterionId: BC7 },
      { n: 2, statement: 'New 2.', requirementCriterionId: BC7 },
      { n: 3, statement: 'New 3.' },
    ];
    expect(named(k65, rewrite)).toEqual(['3 REQ-25 BC-7']);
  });

  it('names a middle line, never the first by default', () => {
    const rewrite = [
      { n: 1, statement: 'New 1.', requirementCriterionId: BC7 },
      { n: 2, statement: 'New 2.' },
      { n: 3, statement: 'New 3.', requirementCriterionId: BC7 },
    ];
    expect(named(k65, rewrite)).toEqual(['2 REQ-25 BC-7']);
  });

  it('names each line that rewords a traced one where the BC moved to a new line, so tagging them converges', () => {
    const rewrite = [
      { n: 1, statement: 'New 1.' },
      { n: 2, statement: 'New 2.' },
      { n: 3, statement: 'New 3.' },
      { n: 4, statement: 'New 4.', requirementCriterionId: BC7 },
    ];
    expect(named(k65, rewrite)).toEqual(['1 REQ-25 BC-7', '2 REQ-25 BC-7', '3 REQ-25 BC-7']);
    const retry = follow(k65, rewrite, droppedTraceDetail(dropped(k65, rewrite)));
    expect(dropped(k65, retry)).toEqual([]);
  });

  it('names the reworded line where an unchanged one moved above it', () => {
    const live = [
      { n: 1, statement: 'Old 1.', requirementCriterionId: BC7 },
      { n: 2, statement: 'Kept.', requirementCriterionId: BC7 },
    ];
    // the kept line moves onto number 1 and the reworded one lands on 2, untagged
    const rewrite = [
      { n: 1, statement: 'Kept.' },
      { n: 2, statement: 'New 1.' },
    ];
    expect(named(live, rewrite)).toEqual(['2 REQ-25 BC-7']);
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
