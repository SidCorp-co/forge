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

describe('parseForgeRecord', () => {
  it('stays the first fence, for the paths that draw one record per comment', () => {
    const body = [...tagAfter(1), ...tagAfter(2)].join('\n');
    expect(parseForgeRecord(body)?.fields.find((f) => f.key === 'criterion')?.value).toBe('1');
  });
});
