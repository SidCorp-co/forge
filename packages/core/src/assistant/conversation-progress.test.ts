/**
 * ISS-1078 — what the socket carries while a Forge UI turn is being written.
 *
 * Three properties are the whole subject here, and each is a thing that was not
 * true before this file existed. A frame carries the canonical entry rather than
 * a doorbell. Frames COALESCE, because this wire streams token by token and each
 * one re-sends the whole entry. And the amnesty that lets unjudged prose out is
 * bounded on both sides: a replaced reply is published MARKED, and what goes to
 * the durable row on that path is the tool record alone.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const publishToConversationReaders = vi.fn();
vi.mock('./conversation-adapter.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    publishToConversationReaders: (...a: unknown[]) => publishToConversationReaders(...a),
  };
});

const { startConversationProgress } = await import('./conversation-progress.js');

/** A clock this test moves by hand, so the coalescing window is measured and not waited out. */
function fakeClock() {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

interface Frame {
  event: string;
  data: {
    conversationId: string;
    entry: { content?: string; blocks?: unknown[] };
    replaced?: true;
  };
}

function framesOf(): Frame[] {
  return publishToConversationReaders.mock.calls.map(([, envelope]) => envelope as Frame);
}

beforeEach(() => {
  publishToConversationReaders.mockReset();
  publishToConversationReaders.mockResolvedValue(1);
});

describe('a streamed turn', () => {
  // cm:guard criterion 4 and 5's producer half: a tool call and its result each reach the wire at
  // the moment they happen, without waiting out the window, because those are the two frames a
  // reader is sitting there waiting for.
  it('flushes a tool call and its result immediately', async () => {
    const clock = fakeClock();
    const p = startConversationProgress({ conversationId: 'conv-1', now: clock.now });

    p.onTurnEvent({ type: 'tool_call', id: 't1', name: 'forge_issues', arguments: '{"a":1}' });
    p.onTurnEvent({ type: 'tool_result', id: 't1', result: 'two rows' });
    await p.onSettled('', false);

    // cm:guard the first two frames are the call and its result; the third is the settling frame
    // every turn now closes with (see "closes with a frame carrying the delivered sentence").
    const tools = framesOf()
      .slice(0, 2)
      .map((f) => f.data.entry.blocks?.length);
    expect(tools).toEqual([1, 1]);
    expect(framesOf()[1]?.event).toBe('conversation.progress');
  });

  // cm:guard this is the reason the window exists at all: each frame carries the WHOLE entry, so a
  // frame per chunk re-sends every settled tool output per token. Six chunks inside one window are
  // one frame, and the assertion is on the COUNT rather than on the text, because a producer that
  // emitted six frames each holding the same growing string would still read correct on content.
  it('coalesces text chunks inside the window into one frame', async () => {
    const clock = fakeClock();
    const p = startConversationProgress({ conversationId: 'conv-1', now: clock.now });

    for (const text of ['a', 'b', 'c', 'd', 'e', 'f']) {
      clock.advance(10);
      p.onTurnEvent({ type: 'chunk', text });
    }
    await p.onSettled('abcdef', false);

    // cm:guard ONE frame out of six chunks, plus the settling frame every turn closes with. The
    // count is the assertion and the text is not: a producer emitting six frames each holding the
    // same growing string would read correct on content and would be re-sending the whole entry per
    // token, which is the one thing the window exists to stop.
    expect(publishToConversationReaders).toHaveBeenCalledTimes(2);
    expect(framesOf()[0]?.data.entry.content).toBe('a');
    expect(framesOf()[1]?.data.entry.content).toBe('abcdef');
  });

  it('flushes again once the window has passed', async () => {
    const clock = fakeClock();
    const p = startConversationProgress({ conversationId: 'conv-1', now: clock.now });

    p.onTurnEvent({ type: 'chunk', text: 'first' });
    clock.advance(500);
    p.onTurnEvent({ type: 'chunk', text: ' second' });
    await p.onSettled('first second', false);

    expect(publishToConversationReaders).toHaveBeenCalledTimes(3);
    expect(framesOf()[1]?.data.entry.content).toBe('first second');
  });

  // cm:guard criterion 18: the accumulator's refusal of a result naming no call is NOT caught here
  // and must not be. The same accumulator produces the blocks written to the durable row, so an
  // unmatched id is an upstream pairing break, and swallowing it here would file a transcript that
  // silently disagrees with what ran. It reaches `external-chat.ts`, which ends the turn on it.
  it('lets the accumulator’s refusal of an unmatched tool result out by name', () => {
    const p = startConversationProgress({ conversationId: 'conv-1' });
    p.onTurnEvent({ type: 'tool_call', id: 't1', name: 'forge_issues', arguments: '{}' });
    expect(() => p.onTurnEvent({ type: 'tool_result', id: 'nope', result: 'x' })).toThrow(
      /names no tool call this turn made/,
    );
  });

  // cm:guard a socket that went away cannot end a turn, which is the other half of the rule above:
  // the refusal that ends a turn is the accumulator's, and a publish failure is not one.
  it('swallows a publish failure and keeps taking events', async () => {
    publishToConversationReaders.mockRejectedValue(new Error('room manager is gone'));
    const clock = fakeClock();
    const p = startConversationProgress({ conversationId: 'conv-1', now: clock.now });

    p.onTurnEvent({ type: 'tool_call', id: 't1', name: 'forge_issues', arguments: '{}' });
    clock.advance(500);
    p.onTurnEvent({ type: 'chunk', text: 'still going' });
    await expect(p.onSettled('still going', false)).resolves.toMatchObject({
      blocks: expect.any(Array),
    });
  });

  // cm:guard criterion 14's producer half. The check is not made here and must not be: every frame
  // goes out through `publishToConversationReaders`, which runs `assertConversationReadable` per
  // participant — the SAME check a delivery makes. A producer that addressed sockets itself would
  // be a second, weaker copy of that rule.
  it('publishes through the room’s own reader check and never past it', async () => {
    const clock = fakeClock();
    const p = startConversationProgress({ conversationId: 'conv-1', now: clock.now });
    p.onTurnEvent({ type: 'tool_call', id: 't1', name: 'forge_issues', arguments: '{}' });
    await p.onSettled('', false);
    expect(publishToConversationReaders.mock.calls[0]?.[0]).toBe('conv-1');
  });
});

describe('a turn whose reply the screen replaced', () => {
  const runTurn = async (streamed: string, delivered: string, screenReplaced = true) => {
    const clock = fakeClock();
    const p = startConversationProgress({
      conversationId: 'conv-1',
      entryId: 'entry-1',
      now: clock.now,
    });
    p.onTurnEvent({ type: 'tool_call', id: 't1', name: 'forge_issues', arguments: '{}' });
    p.onTurnEvent({ type: 'tool_result', id: 't1', result: 'two rows' });
    clock.advance(500);
    p.onTurnEvent({ type: 'chunk', text: streamed });
    return { settled: await p.onSettled(delivered, screenReplaced), clock };
  };

  // cm:guard criterion 8: the replacement is its own MARKED frame and not an edit of the draft in
  // place. A reader who read the refused sentence is owed the fact that it was withdrawn; swapping
  // it silently is the substitution the owner's decision refuses by name.
  it('publishes the replacement marked, carrying the delivered text', async () => {
    await runTurn('the draft the door refused', 'the sentence that went out');
    const last = framesOf().at(-1);
    expect(last?.data.replaced).toBe(true);
    expect(last?.data.entry.content).toBe('the sentence that went out');
  });

  // cm:guard this is the boundary the whole amnesty is bounded by, and it is asserted on the value
  // that reaches the ROW rather than on the frame: the accumulator's text blocks hold the draft, so
  // storing them verbatim beside the replacement would put the refused sentence into the permanent
  // record through `blocks` — where `content` is guarded and `blocks` was not.
  it('hands the record the tool blocks and the delivered sentence, never the refused draft', async () => {
    const { settled } = await runTurn('the draft the door refused', 'the sentence that went out');
    expect(settled.blocks).toEqual([
      { type: 'tool', toolCall: expect.objectContaining({ id: 't1', output: 'two rows' }) },
      { type: 'text', text: 'the sentence that went out' },
    ]);
    expect(JSON.stringify(settled.blocks)).not.toContain('refused');
  });

  // cm:guard the ordinary turn keeps its whole ordered record, which is what makes criterion 10
  // true when the room is re-opened: a turn that ran tools still shows its cards.
  it('hands the record every block when nothing was replaced', async () => {
    const { settled } = await runTurn(
      'the sentence that went out',
      'the sentence that went out',
      false,
    );
    expect(settled.blocks?.map((b) => b.type)).toEqual(['tool', 'text']);
    expect(framesOf().every((f) => f.data.replaced === undefined)).toBe(true);
  });

  // cm:guard criterion 11: the frames and the row share ONE identity, so a client reduces the
  // growing frames and the settled row to a single assistant turn. Two identities for one answer
  // is what made a reducer draw two turns on beta (ISS-1029 review F1).
  it('carries one entry id from the first frame to the row', async () => {
    const { settled } = await runTurn('said', 'said', false);
    expect(settled.entryId).toBe('entry-1');
    const ids = framesOf().map((f) => (f.data.entry as { id: string }).id);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids)).toEqual(new Set(['entry-1']));
  });

  // cm:guard a turn that published NOTHING has nothing to correct, whatever it delivers: an
  // Agent-mode divert and a code-authored line never streamed a word, and marking their reply a
  // correction would tell a reader that text was withdrawn which they never saw.
  it('marks nothing on a turn that never streamed a word, and stores no blocks for it', async () => {
    const p = startConversationProgress({ conversationId: 'conv-1' });
    const settled = await p.onSettled('no paired device is free to take this turn', false);
    expect(publishToConversationReaders).not.toHaveBeenCalled();
    expect(settled.blocks).toBeNull();
  });

  // cm:guard the comparison is against the LAST text block and never the accumulated `content`:
  // a turn that talks before calling a tool accumulates commentary the delivered text never had,
  // and comparing that would mark every such turn a correction the reader has to read past.
  // cm:guard the producer OBEYS the report and derives nothing, which is the property that survives
  // every shape of turn: identical strings marked replaced must still be marked, and different
  // strings reported as accepted must still be left alone. An implementation that compared the two
  // itself passes neither of these, and passed every earlier case in this file.
  it('marks what the runner reports, not what the strings look like', async () => {
    const same = await runTurn('the same sentence', 'the same sentence', true);
    expect(framesOf().at(-1)?.data.replaced).toBe(true);
    expect(
      same.settled.blocks?.some((b) => b.type === 'text' && b.text === 'the same sentence'),
    ).toBe(true);

    publishToConversationReaders.mockClear();
    const differ = await runTurn('a preamble. ', 'the answer nobody replaced', false);
    expect(framesOf().every((f) => f.data.replaced === undefined)).toBe(true);
    expect(differ.settled.blocks?.map((b) => b.type)).toEqual(['tool', 'text']);
  });

  it('does not mark a turn that merely talked before it called a tool', async () => {
    const clock = fakeClock();
    const p = startConversationProgress({ conversationId: 'conv-1', now: clock.now });
    p.onTurnEvent({ type: 'chunk', text: 'let me look that up. ' });
    clock.advance(500);
    p.onTurnEvent({ type: 'tool_call', id: 't1', name: 'forge_issues', arguments: '{}' });
    p.onTurnEvent({ type: 'tool_result', id: 't1', result: 'two rows' });
    clock.advance(500);
    p.onTurnEvent({ type: 'chunk', text: 'there are two.' });
    await p.onSettled('there are two.', false);
    expect(framesOf().every((f) => f.data.replaced === undefined)).toBe(true);
  });
});

describe('the frame a turn closes on', () => {
  // cm:guard consult F2: the closing chunks of an answer almost always land inside the coalescing
  // window, so without a settling frame the socket's last view of an ordinary reply is a truncated
  // one — and stays truncated until the durable row is read back. The assertion serializes each
  // frame as it is published, because a mock that kept the live object would read correct against a
  // producer that had published nothing at all.
  it('closes with a frame carrying the delivered sentence', async () => {
    const serialized: string[] = [];
    publishToConversationReaders.mockImplementation(async (_id: string, env: unknown) => {
      serialized.push(JSON.stringify(env));
      return 1;
    });
    const clock = fakeClock();
    const p = startConversationProgress({ conversationId: 'conv-1', now: clock.now });
    p.onTurnEvent({ type: 'chunk', text: 'hel' });
    p.onTurnEvent({ type: 'chunk', text: 'lo' });
    await p.onSettled('hello', false);

    expect(JSON.parse(serialized[serialized.length - 1] as string).data.entry.content).toBe(
      'hello',
    );
  });

  // cm:guard consult F1. The sequence is TEXT CHUNKS on purpose and not a tool round-trip: the
  // accumulator appends chunks into the open text block of the entry it already returned, while a
  // tool result goes through `mergeMessages`, which hands back a NEW object — so a producer that
  // queued the live reference is invisible on the tool path and plainly wrong on this one. The frame
  // is serialized the moment it is published, and publication is held open while more text arrives:
  // queueing the live entry makes the first frame carry text that had not been written when it was
  // flushed, which on this wire is the caret jumping ahead of the turn.
  it('freezes each frame at its own flush boundary', async () => {
    const serialized: string[] = [];
    let release = (): void => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    publishToConversationReaders.mockImplementation(async (_id: string, env: unknown) => {
      serialized.push(JSON.stringify(env));
      await held;
      return 1;
    });
    const clock = fakeClock();
    const p = startConversationProgress({ conversationId: 'conv-1', now: clock.now });

    p.onTurnEvent({ type: 'chunk', text: 'the answer is ' });
    clock.advance(500);
    p.onTurnEvent({ type: 'chunk', text: 'forty' });
    p.onTurnEvent({ type: 'chunk', text: '-two' });
    release();
    await p.onSettled('the answer is forty-two', false);

    expect(JSON.parse(serialized[0] as string).data.entry.content).toBe('the answer is ');
    expect(JSON.parse(serialized.at(-1) as string).data.entry.content).toBe(
      'the answer is forty-two',
    );
  });
});
