import { describe, expect, it, vi } from 'vitest';

const { loggerWarn } = vi.hoisted(() => ({ loggerWarn: vi.fn() }));
vi.mock('../logger.js', () => ({
  logger: { warn: loggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  type ConversationProgressFrame,
  startConversationProgress,
} from './conversation-progress.js';
import type { ChatStreamEvent } from './providers/types.js';

/** A clock the test moves by hand, so the coalescing window is never a sleep. */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function watcher(over: { now?: () => number } = {}) {
  const frames: ConversationProgressFrame[] = [];
  const publish = vi.fn(async (_id: string, envelope: { event: string; data: unknown }) => {
    frames.push(envelope.data as ConversationProgressFrame);
    return 1;
  });
  const progress = startConversationProgress({
    conversationId: 'room-1',
    entryId: 'entry-1',
    publish,
    ...(over.now ? { now: over.now } : {}),
  });
  return { progress, publish, frames };
}

const chunk = (text: string): ChatStreamEvent => ({ type: 'chunk', text });
const call = (id: string): ChatStreamEvent => ({
  type: 'tool_call',
  id,
  name: 'forge_issues',
  arguments: '{"action":"list"}',
});
const resultOf = (id: string): ChatStreamEvent => ({ type: 'tool_result', id, result: 'ok' });
const reason = (text: string): ChatStreamEvent => ({ type: 'reasoning', text });

/** The publishes are chained, so a test reads the frames after the chain drains. */
const drain = () => new Promise((r) => setTimeout(r, 0));

describe('a turn published while it runs', () => {
  it('coalesces prose instead of publishing a frame per token', async () => {
    const c = clock();
    const { progress, frames } = watcher({ now: c.now });

    for (const word of ['The ', 'issue ', 'list ', 'says ', 'how ', 'long']) {
      progress.onTurnEvent(chunk(word));
    }
    await drain();

    expect(frames).toHaveLength(1);
    expect(frames[0]?.entry.content).toBe('The ');
  });

  it('freezes a frame at the boundary it was flushed on', async () => {
    const serialized: string[] = [];
    let release = (): void => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const publish = vi.fn(async (_id: string, envelope: { event: string; data: unknown }) => {
      serialized.push(JSON.stringify(envelope.data));
      await held;
      return 1;
    });
    const c = clock();
    const progress = startConversationProgress({
      conversationId: 'room-1',
      entryId: 'entry-1',
      publish,
      now: c.now,
    });

    progress.onTurnEvent(chunk('the answer is '));
    c.advance(200);
    progress.onTurnEvent(chunk('forty'));
    progress.onTurnEvent(chunk('-two'));
    release();
    await drain();

    expect(JSON.parse(serialized[0] as string).entry.content).toBe('the answer is ');
  });

  it('publishes again once the window has passed', async () => {
    const c = clock();
    const { progress, frames } = watcher({ now: c.now });

    progress.onTurnEvent(chunk('first'));
    c.advance(200);
    progress.onTurnEvent(chunk(' second'));
    await drain();

    expect(frames).toHaveLength(2);
    expect(frames[1]?.entry.content).toBe('first second');
  });

  it('flushes a tool call the moment the model makes it, inside the window', async () => {
    const c = clock();
    const { progress, frames } = watcher({ now: c.now });

    progress.onTurnEvent(chunk('Let me look.'));
    await drain();
    const before = frames.length;
    progress.onTurnEvent(call('c1'));
    await drain();

    expect(frames.length).toBe(before + 1);
    const blocks = frames.at(-1)?.entry.blocks ?? [];
    expect(blocks.at(-1)).toMatchObject({ type: 'tool', toolCall: { id: 'c1' } });
  });

  it('flushes a tool result the moment it returns, inside the window', async () => {
    const c = clock();
    const { progress, frames } = watcher({ now: c.now });

    progress.onTurnEvent(call('c1'));
    await drain();
    const before = frames.length;
    progress.onTurnEvent(resultOf('c1'));
    await drain();

    expect(frames.length).toBe(before + 1);
    const tool = frames.at(-1)?.entry.toolCalls?.[0];
    expect(tool).toMatchObject({ id: 'c1', output: 'ok' });
  });

  it('refuses a tool result naming no call this turn made, by name', () => {
    const { progress } = watcher();

    progress.onTurnEvent(call('c1'));

    expect(() => progress.onTurnEvent(resultOf('nope'))).toThrow(/names no tool call/);
  });

  it('catches a frame that cannot be published, rather than leaving it to reject', async () => {
    loggerWarn.mockClear();
    const publish = vi.fn(async () => {
      throw new Error('no socket');
    });
    const progress = startConversationProgress({
      conversationId: 'room-1',
      entryId: 'entry-1',
      publish,
    });

    progress.onTurnEvent(chunk('hello'));
    await drain();

    expect(publish).toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'room-1' }),
      expect.stringContaining('was not published'),
    );
  });

  it('carries a monotonic rev so a client can order what it receives', async () => {
    const c = clock();
    const { progress, frames } = watcher({ now: c.now });

    progress.onTurnEvent(chunk('a'));
    progress.onTurnEvent(call('c1'));
    progress.onTurnEvent(resultOf('c1'));
    await drain();

    expect(frames.map((f) => f.rev)).toEqual([...frames.keys()].map((i) => i + 1));
  });
});

describe('when the screen replaces the draft', () => {
  it('publishes the replacement marked as a correction, carrying the draft it replaces', async () => {
    const c = clock();
    const { progress, frames } = watcher({ now: c.now });

    progress.onTurnEvent(chunk('ISS-1033 shipped last week.'));
    await drain();
    progress.onSettled({ text: 'ISS-1033 is still running.', screenReplaced: true });
    await drain();

    const last = frames.at(-1);
    expect(last?.replaced).toEqual({ draft: 'ISS-1033 shipped last week.' });
    expect(last?.entry.content).toBe('ISS-1033 is still running.');
  });

  it('publishes nothing further when the screen admitted what was streamed', async () => {
    const c = clock();
    const { progress, frames } = watcher({ now: c.now });

    progress.onTurnEvent(chunk('ISS-1033 is running.'));
    await drain();
    const before = frames.length;
    progress.onSettled({ text: 'ISS-1033 is running.', screenReplaced: false });
    await drain();

    expect(frames.length).toBe(before);
  });

  it('compares against the accumulated draft, not the last frame published', async () => {
    const c = clock();
    const { progress, frames } = watcher({ now: c.now });

    progress.onTurnEvent(chunk('half a sentence'));
    await drain();
    progress.onTurnEvent(chunk(' and the rest'));
    progress.onSettled({ text: 'half a sentence and the rest', screenReplaced: false });
    await drain();

    expect(frames.some((f) => f.replaced)).toBe(false);
  });

  it('corrects the text without accusing the screen, when the screen admitted the draft', async () => {
    const c = clock();
    const { progress, frames } = watcher({ now: c.now });

    progress.onTurnEvent(chunk('Let me set that for you.'));
    progress.onTurnEvent(call('c1'));
    progress.onTurnEvent(resultOf('c1'));
    progress.onTurnEvent(chunk('Done — your replies are concise now.'));
    await drain();
    progress.onSettled({
      text: 'Done — your replies are concise now.',
      screenReplaced: false,
    });
    await drain();

    const last = frames.at(-1);
    expect(last?.replaced).toBeUndefined();
    expect(last?.entry.content).toBe('Done — your replies are concise now.');
    expect(last?.entry.blocks?.some((b) => b.type === 'tool')).toBe(true);
    expect(JSON.stringify(last?.entry.blocks)).not.toContain('Let me set that for you');
  });
});

describe('the blocks a delivered reply is stored with', () => {
  it('keeps the whole interleaving when the screen admitted what streamed', () => {
    const { progress } = watcher();

    progress.onTurnEvent(chunk('Let me look.'));
    progress.onTurnEvent(call('c1'));
    progress.onTurnEvent(resultOf('c1'));
    progress.onTurnEvent(chunk('ISS-1033 is running.'));

    const blocks = progress.blocksForRecord('Let me look.ISS-1033 is running.');

    expect(blocks?.map((b) => b.type)).toEqual(['text', 'tool', 'text']);
  });

  it('replaces the draft text block with the delivered text, keeping the tools', () => {
    const { progress } = watcher();

    progress.onTurnEvent(chunk('ISS-1033 shipped last week.'));
    progress.onTurnEvent(call('c1'));
    progress.onTurnEvent(resultOf('c1'));

    const blocks = progress.blocksForRecord('ISS-1033 is still running.');

    expect(blocks?.map((b) => b.type)).toEqual(['tool', 'text']);
    expect(blocks?.at(-1)).toEqual({ type: 'text', text: 'ISS-1033 is still running.' });
    expect(JSON.stringify(blocks)).not.toContain('shipped last week');
  });

  it('keeps the reasoning beside the tools when the delivered text is not the draft', () => {
    const { progress } = watcher();

    progress.onTurnEvent(reason('let me check the list'));
    progress.onTurnEvent(chunk('Let me look.'));
    progress.onTurnEvent(call('c1'));
    progress.onTurnEvent(resultOf('c1'));
    progress.onTurnEvent(chunk('ISS-1033 is running.'));

    const blocks = progress.blocksForRecord('ISS-1033 is running.');

    expect(blocks?.map((b) => b.type)).toEqual(['thinking', 'tool', 'text']);
    expect(blocks?.[0]).toMatchObject({ thinking: 'let me check the list' });
    expect(blocks?.at(-1)).toEqual({ type: 'text', text: 'ISS-1033 is running.' });
    expect(JSON.stringify(blocks)).not.toContain('Let me look.');
  });

  it('keeps an encrypted pause in what the record is given', () => {
    const { progress } = watcher();

    progress.onTurnEvent({ type: 'reasoning', text: '', redacted: true });
    progress.onTurnEvent(chunk('Let me look.'));
    progress.onTurnEvent(call('c1'));
    progress.onTurnEvent(resultOf('c1'));
    progress.onTurnEvent(chunk('Two left.'));

    const blocks = progress.blocksForRecord('Two left.');

    expect(blocks?.map((b) => b.type)).toEqual(['thinking', 'tool', 'text']);
    expect(blocks?.[0]).toEqual({ type: 'thinking' });
  });

  it('keeps the reasoning of a replaced reply that ran no tools at all', () => {
    const { progress } = watcher();

    progress.onTurnEvent(reason('hmm'));
    progress.onTurnEvent(chunk('ISS-1033 shipped last week.'));

    const blocks = progress.blocksForRecord('ISS-1033 is still running.');

    expect(blocks?.map((b) => b.type)).toEqual(['thinking', 'text']);
    expect(JSON.stringify(blocks)).not.toContain('shipped last week');
  });

  it('stores nothing rather than an empty record when a replaced reply ran no tools', () => {
    const { progress } = watcher();

    progress.onTurnEvent(chunk('ISS-1033 shipped last week.'));

    expect(progress.blocksForRecord('ISS-1033 is still running.')).toBeNull();
  });

  it('stores nothing for a turn that produced no blocks at all', () => {
    const { progress } = watcher();

    expect(progress.blocksForRecord('a code-authored fallback')).toBeNull();
  });
});

describe('closing the watcher', () => {
  it('waits for a frame already queued, so nothing lands after the settle', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const landed: number[] = [];
    const publish = vi.fn(async (_id: string, envelope: { data: unknown }) => {
      await held;
      landed.push((envelope.data as ConversationProgressFrame).rev);
      return 1;
    });
    const progress = startConversationProgress({
      conversationId: 'room-1',
      entryId: 'entry-1',
      publish,
    });

    progress.onTurnEvent(chunk('half an answer'));
    const closing = progress.close();
    expect(landed).toEqual([]);
    release?.();
    await closing;

    expect(landed).toEqual([1]);
  });

  it('publishes nothing once closed', async () => {
    const c = clock();
    const { progress, frames } = watcher({ now: c.now });

    await progress.close();
    progress.onTurnEvent(chunk('too late'));
    progress.onSettled({ text: 'and this too', screenReplaced: true });
    await drain();

    expect(frames).toEqual([]);
  });
});

describe('the corrected frame', () => {
  it('carries the replacement in its blocks, not the draft it replaced', async () => {
    const c = clock();
    const { progress, frames } = watcher({ now: c.now });

    progress.onTurnEvent(chunk('ISS-1033 shipped last week.'));
    progress.onTurnEvent(call('c1'));
    progress.onTurnEvent(resultOf('c1'));
    await drain();
    progress.onSettled({ text: 'ISS-1033 is still running.', screenReplaced: true });
    await drain();

    const last = frames.at(-1);
    expect(last?.replaced).toEqual({ draft: 'ISS-1033 shipped last week.' });
    expect(JSON.stringify(last?.entry.blocks)).not.toContain('shipped last week');
    expect(last?.entry.blocks?.at(-1)).toEqual({
      type: 'text',
      text: 'ISS-1033 is still running.',
    });
  });

  it('carries the replacement as its only text when the turn ran no tools', async () => {
    const c = clock();
    const { progress, frames } = watcher({ now: c.now });

    progress.onTurnEvent(chunk('a draft nobody admitted'));
    await drain();
    progress.onSettled({ text: 'the sentence that went out', screenReplaced: true });
    await drain();

    const blocks = frames.at(-1)?.entry.blocks;
    expect(blocks).toEqual([{ type: 'text', text: 'the sentence that went out' }]);
  });
});
