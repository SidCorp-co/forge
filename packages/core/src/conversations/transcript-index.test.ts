import { describe, expect, it } from 'vitest';
import {
  buildPassages,
  eligibleForIndex,
  fragmentsOf,
  type IndexableMessage,
  PASSAGE_MAX_CHARS,
  PASSAGE_MAX_MESSAGES,
  PASSAGE_TEXT_BOUND,
  SPEAKER_LABEL_CAP,
  sourceOf,
} from './transcript-index.js';

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));

function msg(seq: number, content: string, label: string | null = 'ana'): IndexableMessage {
  return { seq, role: 'user', authorLabel: label, content, createdAt: at(seq) };
}

describe('eligibleForIndex', () => {
  it('admits a message from a window nothing answered, because it reads nothing about the window', () => {
    // The row a `guard-dormant` or `nothing-to-say` window left behind is an ordinary
    // transcript row: the decision lives on `conversation_windows` and never on the message.
    expect(eligibleForIndex(msg(4, 'we agreed to drop the retry ladder'))).toBe(true);
  });

  it('leaves out a recorded silence, which carries its reason in a column and no text', () => {
    expect(eligibleForIndex(msg(5, ''))).toBe(false);
    expect(eligibleForIndex(msg(6, '   \n  '))).toBe(false);
  });
});

describe('fragmentsOf', () => {
  it('gives a short message one fragment at offset zero', () => {
    const frags = fragmentsOf(msg(0, '  hello there  '));
    expect(frags.map((f) => [f.seq, f.offset, f.text])).toEqual([[0, 0, 'hello there']]);
  });

  it('cuts a message over the bound into consecutive fragments that reassemble it exactly', () => {
    const body = `${'word '.repeat(1400)}end`;
    const m = msg(3, body);
    const frags = fragmentsOf(m);
    expect(frags.length).toBeGreaterThan(3);
    for (const f of frags) expect(f.text.length).toBeLessThanOrEqual(PASSAGE_MAX_CHARS);
    expect(frags.map((f) => f.text).join('')).toBe(sourceOf(m));
    const expectedOffsets: number[] = [];
    let running = 0;
    for (const f of frags) {
      expectedOffsets.push(running);
      running += f.text.length;
    }
    expect(frags.map((f) => f.offset)).toEqual(expectedOffsets);
  });

  it('hard-cuts a message with no whitespace to cut at, rather than looping', () => {
    const m = msg(1, 'x'.repeat(PASSAGE_MAX_CHARS * 2 + 7));
    const frags = fragmentsOf(m);
    expect(frags.map((f) => f.text.length)).toEqual([PASSAGE_MAX_CHARS, PASSAGE_MAX_CHARS, 7]);
    expect(frags.map((f) => f.text).join('')).toBe(sourceOf(m));
  });

  it('resumes from an offset, yielding only the rest of the message', () => {
    const m = msg(1, 'abcdefghij');
    expect(fragmentsOf(m, 4).map((f) => [f.offset, f.text])).toEqual([[4, 'efghij']]);
  });

  it('clips the speaker label so a passage line has a bound', () => {
    const [f] = fragmentsOf(msg(0, 'hi', 'n'.repeat(120)));
    expect(f?.label).toHaveLength(SPEAKER_LABEL_CAP);
  });

  it('falls back to the role where the transport named no speaker', () => {
    const [f] = fragmentsOf({ ...msg(0, 'hi'), authorLabel: null, role: 'assistant' });
    expect(f?.label).toBe('assistant');
  });
});

describe('buildPassages', () => {
  it('returns nothing for a room with no messages', () => {
    expect(buildPassages([])).toEqual([]);
  });

  it('returns nothing for a room whose every row is a recorded silence', () => {
    expect(buildPassages([msg(0, ''), msg(1, '  '), msg(2, '')])).toEqual([]);
  });

  it('gives a room with one message exactly one open passage covering it', () => {
    const drafts = buildPassages([msg(0, 'the decision was to keep the ladder')]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      firstSeq: 0,
      firstOffset: 0,
      lastSeq: 0,
      lastOffset: 'the decision was to keep the ladder'.length,
      fragmentCount: 1,
      isOpen: true,
      text: '[ana]: the decision was to keep the ladder',
    });
  });

  it('closes a passage on the fragment ceiling and leaves the tail open', () => {
    const drafts = buildPassages(Array.from({ length: 25 }, (_, i) => msg(i, `line ${i}`)));
    expect(drafts.map((d) => d.fragmentCount)).toEqual([
      PASSAGE_MAX_MESSAGES,
      PASSAGE_MAX_MESSAGES,
      5,
    ]);
    expect(drafts.map((d) => d.isOpen)).toEqual([false, false, true]);
    expect(drafts.map((d) => [d.firstSeq, d.lastSeq])).toEqual([
      [0, 9],
      [10, 19],
      [20, 24],
    ]);
  });

  it('closes a passage on the character ceiling', () => {
    const drafts = buildPassages([
      msg(0, 'a'.repeat(1200)),
      msg(1, 'b'.repeat(900)),
      msg(2, 'c'.repeat(10)),
    ]);
    expect(drafts.map((d) => d.fragmentCount)).toEqual([1, 2]);
    expect(drafts[0]).toMatchObject({ firstSeq: 0, lastSeq: 0, isOpen: false });
  });

  it('holds every passage under the declared text bound', () => {
    const drafts = buildPassages([
      ...Array.from({ length: 40 }, (_, i) => msg(i, `${'z'.repeat(300)} ${i}`, 'x'.repeat(90))),
      msg(40, 'y'.repeat(PASSAGE_MAX_CHARS * 3)),
    ]);
    for (const d of drafts) expect(d.text.length).toBeLessThanOrEqual(PASSAGE_TEXT_BOUND);
  });

  it('skips a silence without breaking the run around it', () => {
    const drafts = buildPassages([msg(0, 'before'), msg(1, ''), msg(2, 'after')]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ firstSeq: 0, lastSeq: 2, fragmentCount: 2 });
    expect(drafts[0]?.text).toBe('[ana]: before\n[ana]: after');
  });

  it('reassembles an oversized message exactly from the offsets its passages record', () => {
    const body = `${'sentence here '.repeat(700)}tail`;
    const drafts = buildPassages([msg(7, body)]);
    expect(drafts.length).toBeGreaterThan(3);
    const src = sourceOf(msg(7, body));
    const rebuilt = drafts
      .map((d) => {
        expect(d.firstSeq).toBe(7);
        expect(d.lastSeq).toBe(7);
        return src.slice(d.firstOffset, d.lastOffset);
      })
      .join('');
    expect(rebuilt).toBe(src);
    const starts = [0, ...drafts.slice(0, -1).map((d) => d.lastOffset)];
    expect(drafts.map((d) => d.firstOffset)).toEqual(starts);
  });

  it('is prefix-stable: the passages a suffix produces are the ones a whole rebuild produces', () => {
    // This is what makes an incremental pass equal a rebuild, and it is asserted rather
    // than argued: the passages after the resume point must be byte-identical either way.
    const all = Array.from({ length: 34 }, (_, i) => msg(i, `turn ${i} about the retry ladder`));
    const whole = buildPassages(all);
    const openTail = whole[whole.length - 1];
    const resumed = buildPassages(
      all.filter((m) => m.seq >= (openTail?.firstSeq ?? 0)),
      { seq: openTail?.firstSeq ?? 0, offset: openTail?.firstOffset ?? 0 },
    );
    expect(resumed).toEqual([openTail]);
  });

  it('applies a resume offset only to the message it names', () => {
    const drafts = buildPassages([msg(4, 'abcdef'), msg(5, 'ghijkl')], { seq: 4, offset: 3 });
    expect(drafts[0]).toMatchObject({ firstSeq: 4, firstOffset: 3, lastSeq: 5, lastOffset: 6 });
    expect(drafts[0]?.text).toBe('[ana]: def\n[ana]: ghijkl');
  });
});
