import { describe, expect, it } from 'vitest';
import { type CarrierRow, contiguousPrefix } from './session-transcript.js';

const row = (seq: number): CarrierRow => ({
  kind: 'stdout',
  data: { line: { type: 'assistant', message: { content: [{ type: 'text', text: `#${seq}` }] } } },
  ts: new Date(seq * 1000),
  seq,
});

const seqs = (rows: CarrierRow[]) => rows.map((r) => r.seq);

describe('the checkpoint advances over a contiguous prefix', () => {
  it('takes every row of an unbroken run from the cursor', () => {
    expect(seqs(contiguousPrefix([row(1), row(2), row(3)], 0))).toEqual([1, 2, 3]);
    expect(seqs(contiguousPrefix([row(4), row(5)], 3))).toEqual([4, 5]);
  });

  it('stops at the first gap rather than folding what lies past it', () => {
    expect(seqs(contiguousPrefix([row(1), row(2), row(4), row(5)], 0))).toEqual([1, 2]);
  });

  it('answers with nothing when the very first row is not the one the cursor expects', () => {
    expect(contiguousPrefix([row(7), row(8)], 0)).toEqual([]);
    expect(contiguousPrefix([row(9)], 3)).toEqual([]);
  });

  it('reads the rows past a filled hole on the next pass', () => {
    // First pass: 3 is missing, so the fold stops at 2 and checkpoints there.
    expect(seqs(contiguousPrefix([row(1), row(2), row(4), row(5)], 0))).toEqual([1, 2]);
    // The late batch lands. The next pass reads from the checkpoint and the run
    // is unbroken, so nothing was lost — only deferred.
    expect(seqs(contiguousPrefix([row(3), row(4), row(5)], 2))).toEqual([3, 4, 5]);
  });

  it('answers with nothing when handed rows the cursor has already passed', () => {
    expect(contiguousPrefix([row(1), row(2), row(3)], 2)).toEqual([]);
  });

  it('answers with nothing for an empty carrier, whatever the cursor', () => {
    expect(contiguousPrefix([], 0)).toEqual([]);
    expect(contiguousPrefix([], 12)).toEqual([]);
  });
});
