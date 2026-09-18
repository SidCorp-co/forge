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

  // cm:guard this is the case `gt(seq, lastSeq)` alone gets WRONG, and it is the
  // reason this rule exists. The runner assigns `seq` now, so a batch can commit
  // after a later one: with a bare cursor the fold would take 4 and 5, set the
  // checkpoint to 5, and 3 would be excluded by that predicate for ever — a
  // transcript missing its middle and nothing anywhere saying so.
  it('stops at the first gap rather than folding what lies past it', () => {
    expect(seqs(contiguousPrefix([row(1), row(2), row(4), row(5)], 0))).toEqual([1, 2]);
  });

  it('answers with nothing when the very first row is not the one the cursor expects', () => {
    // A rebuild over a history whose start is missing: the caller reads this
    // empty answer as "this carrier can no longer rebuild that transcript" and
    // leaves the stored one standing rather than replacing it with a suffix.
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

  // cm:guard the rows handed here are already filtered to `seq > afterSeq` by the
  // reader's own WHERE. This case pins that contract rather than papering over a
  // breach of it: a caller that stopped filtering gets an empty answer, which the
  // derive reads as "cannot rebuild" and answers by leaving the stored transcript
  // alone — never by folding a set starting behind its own cursor.
  it('answers with nothing when handed rows the cursor has already passed', () => {
    expect(contiguousPrefix([row(1), row(2), row(3)], 2)).toEqual([]);
  });

  it('answers with nothing for an empty carrier, whatever the cursor', () => {
    expect(contiguousPrefix([], 0)).toEqual([]);
    expect(contiguousPrefix([], 12)).toEqual([]);
  });
});
