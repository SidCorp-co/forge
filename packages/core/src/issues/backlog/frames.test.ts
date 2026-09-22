import { describe, expect, it } from 'vitest';
import { parseSseStream } from '../../assistant/providers/sse.js';
import { type BacklogFrame, frameData, SHUTTING_DOWN, sseMessage } from './frames.js';

const FRAMES: BacklogFrame[] = [
  {
    type: 'meta',
    kind: 'ordering',
    projectId: '11111111-1111-4111-8111-111111111111',
    total: 842,
    bound: { items: 1000, budgetMs: 300_000 },
    at: '2026-09-22T00:00:00.000Z',
  },
  { type: 'item', seq: 1, payload: { issueId: 'a', title: 'first' } },
  { type: 'progress', emitted: 300, total: 842, elapsedMs: 41_230 },
  { type: 'end', complete: true, truncated: false, truncatedBy: null, emitted: 842, total: 842 },
  { type: 'error', code: SHUTTING_DOWN, message: 'core is shutting down', emitted: 412 },
];

/** The wire as a client sees it: one `event:` line, one `data:` line, one blank line. */
function wire(frames: BacklogFrame[]): ReadableStream<Uint8Array> {
  const text = frames
    .map((f) => {
      const m = sseMessage(f);
      return `event: ${m.event}\ndata: ${m.data}\n\n`;
    })
    .join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe('backlog frames', () => {
  it('survives a reader that keeps only data: lines, which is this repo’s own parser', async () => {
    const read: unknown[] = [];
    for await (const data of parseSseStream(wire(FRAMES))) read.push(JSON.parse(data));

    // parseSseStream discards `event:` entirely, so the kind has to be in the payload or it is lost.
    expect(read.map((f) => (f as { type: string }).type)).toEqual([
      'meta',
      'item',
      'progress',
      'end',
      'error',
    ]);
  });

  it('names the kind on the event: line as well, for a reader that does read it', () => {
    expect(FRAMES.map((f) => sseMessage(f).event)).toEqual([
      'meta',
      'item',
      'progress',
      'end',
      'error',
    ]);
  });

  it('flattens an item payload so a reader never unwraps', () => {
    const data = JSON.parse(
      frameData({ type: 'item', seq: 7, payload: { issueId: 'x', hits: [] } }),
    );
    expect(data).toEqual({ type: 'item', seq: 7, issueId: 'x', hits: [] });
    expect(data).not.toHaveProperty('payload');
  });

  it('carries no rank, score total or ordering position of its own', () => {
    const data = JSON.parse(frameData({ type: 'item', seq: 3, payload: { issueId: 'x' } }));
    expect(Object.keys(data)).toEqual(['type', 'seq', 'issueId']);
  });
});
