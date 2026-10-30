/**
 * ISS-608 — a body is read for every record fence it opens, each with its index, so the comment
 * door can record or refuse each one by name instead of reading the first and dropping the rest.
 */
import { describe, expect, it } from 'vitest';
import { parseForgeRecord, readForgeRecords } from './forge-record.js';

const F = '```';
const tagAfter = (n: number): string[] => [
  `${F}forge-record`,
  `criterion: ${n}`,
  'verdict: pass',
  F,
  '',
  '`forge-record: verdict · contract 1`',
];
const onFence = (n: number): string[] => [
  `${F}forge-record: verdict · contract 1`,
  `criterion: ${n}`,
  'verdict: pass',
  F,
];
const criterionOf = (read: ReturnType<typeof readForgeRecords>[number]) =>
  read.record?.fields.find((f) => f.key === 'criterion')?.value;

describe('readForgeRecords', () => {
  it('reads every fence of a body, in order, each with its index', () => {
    const body = ['Judged.', '', ...tagAfter(1), '', ...onFence(2), 'between', ...tagAfter(3)].join(
      '\n',
    );
    const reads = readForgeRecords(body);
    expect(reads.map((r) => r.index)).toEqual([1, 2, 3]);
    expect(reads.map(criterionOf)).toEqual(['1', '2', '3']);
    expect(reads.every((r) => r.record?.kind === 'verdict' && r.fault === null)).toBe(true);
  });

  it('places each block where it sits, the tag line inside the one it closes', () => {
    const body = [...tagAfter(1), ...onFence(2)].join('\n');
    const [one, two] = readForgeRecords(body);
    expect(body.slice(one?.record?.at, one?.record?.to)).toBe(tagAfter(1).join('\n'));
    expect(body.slice(two?.record?.at, two?.record?.to)).toBe(onFence(2).join('\n'));
  });

  it('answers nothing for a body with no fence', () => {
    expect(readForgeRecords('plain prose, no record')).toEqual([]);
    expect(readForgeRecords(null)).toEqual([]);
  });

  it('faults a malformed later fence by its index and keeps reading past it', () => {
    const body = [
      ...tagAfter(1),
      `${F}forge-record verdict`,
      'criterion: 2',
      F,
      ...tagAfter(3),
    ].join('\n');
    const reads = readForgeRecords(body);
    expect(reads.map((r) => [r.index, r.record !== null, r.fault !== null])).toEqual([
      [1, true, false],
      [2, false, true],
      [3, true, false],
    ]);
    expect(reads[1]?.fault?.quote).toBe(`${F}forge-record verdict`);
  });

  it('faults a fence that is never closed and stops there, since the rest is its content', () => {
    const opensAgain = `${F}forge-record: verdict · contract 1`;
    const body = [
      ...tagAfter(1),
      `${F}forge-record`,
      'criterion: 2',
      opensAgain,
      'criterion: 3',
    ].join('\n');
    const reads = readForgeRecords(body);
    expect(reads).toHaveLength(2);
    expect(reads[1]?.fault?.why).toContain('never closed');
  });

  it('reads a fence quoted inside an enclosing fence as content, not as a record', () => {
    const body = [...tagAfter(1), '````', ...tagAfter(2), '````'].join('\n');
    expect(readForgeRecords(body).map(criterionOf)).toEqual(['1']);
  });

  it('reads a fence naming no kind as a record of no kind, for the door to refuse', () => {
    const [read] = readForgeRecords([`${F}forge-record`, 'criterion: 1', F].join('\n'));
    expect(read?.record?.kind).toBeNull();
    expect(read?.fault).toBeNull();
  });
});

// adminhub-api ISS-83 and ISS-84 (2026-10-30): a marker written above its fence tagged nothing, or
// the fence above it, and the record written under it was never read as itself
describe('a tag line above its fence', () => {
  const MARKER = '`forge-record: verdict · contract 1`';
  const bare = (n: number) => [`${F}forge-record`, `criterion: ${n}`, 'verdict: pass', F];

  it('faults the fence it stands above, naming where the tag line goes', () => {
    const [read] = readForgeRecords(['Judged.', '', MARKER, ...bare(1)].join('\n'));
    expect(read?.record).toBeNull();
    expect(read?.fault?.quote).toBe(MARKER);
    expect(read?.fault?.why).toContain(
      'sits above its `forge-record` fence, where no reader looks',
    );
    expect(read?.fault?.why).toContain(
      'it goes on the line after the closing fence, or on the opening fence itself',
    );
  });

  it('faults the first of two fences each with its marker above, though the second marker would tag it', () => {
    const reads = readForgeRecords([MARKER, ...bare(1), '', MARKER, ...bare(2)].join('\n'));
    expect(reads.map((r) => [r.index, r.fault?.quote ?? null])).toEqual([
      [1, MARKER],
      [2, null],
    ]);
    expect(reads[1]?.record?.kind).toBeNull();
  });

  it('faults a marker above a fence that already names its kind', () => {
    const [read] = readForgeRecords([MARKER, '', ...onFence(1)].join('\n'));
    expect(read?.fault?.quote).toBe(MARKER);
  });

  it("takes a tag line closing one block, straight above the next, as that block's own", () => {
    const reads = readForgeRecords([...tagAfter(1), ...tagAfter(2)].join('\n'));
    expect(reads.map((r) => [criterionOf(r), r.fault])).toEqual([
      ['1', null],
      ['2', null],
    ]);
  });
});

describe('parseForgeRecord', () => {
  it('stays the first fence, for the paths that draw one record per comment', () => {
    const body = [...tagAfter(1), ...tagAfter(2)].join('\n');
    expect(parseForgeRecord(body)?.fields.find((f) => f.key === 'criterion')?.value).toBe('1');
  });
});
