// A turn that runs past 90 seconds posts a partial reply, and its window closes so the room is not
// held for the rest. Lane A8b found the rest's dropped blocks only logged: the window had closed
// before the rest settled. The window's record now stays open for the rest, until a stated bound.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnOutcome } from './turn-request.js';

const writes: { windowId: string; continued: Record<string, unknown> }[] = [];
const closes: { decision: string; detail: Record<string, unknown> }[] = [];
const routed: { current: unknown } = { current: null };

vi.mock('../conversations/index.js', () => ({
  claimOf: (w: { claimedAt: Date | null; claimedBy: string | null }) =>
    w.claimedAt && w.claimedBy ? { claimedAt: w.claimedAt, claimedBy: w.claimedBy } : null,
  closeWindow: async (args: { decision: string; detail: Record<string, unknown> }) => {
    closes.push(args);
    return {};
  },
  settleContinuedWindow: async (args: { windowId: string; continued: Record<string, unknown> }) => {
    writes.push(args);
    return true;
  },
  newRequestTrack: () => ({}),
  statusAfterThrow: async () => null,
  windowDeliveryKey: (id: string) => `window:${id}`,
}));
vi.mock('./window-decision.js', () => ({ decide: async () => routed.current }));

const { routeWindow } = await import('./route-window.js');
const { routedOutcome } = await import('./window-outcome.js');

const window = {
  id: 'w-1',
  conversationId: 'c-1',
  projectId: 'p-1',
  adapter: 'web',
  openedAt: new Date(Date.now() - 5000),
  extendedAt: new Date(Date.now() - 5000),
  firstSeq: 1,
  lastSeq: 1,
  claimedAt: new Date(),
  claimedBy: 'core-1',
  cutReason: 'quiet',
  deliveryReservedAt: null,
  closedAt: null,
  decision: null,
  decisionDetail: null,
  origin: 'inbound',
} as const;

const DROPPED = [{ kind: 'table', runId: 'r-1', why: 'the turn sent none of its own words' }];

function continuedTurn(rest: Promise<TurnOutcome>, until: Date): TurnOutcome {
  return { kind: 'delivered', messageId: 'm-partial', continuation: { rest, until } };
}

beforeEach(() => {
  writes.length = 0;
  closes.length = 0;
});

describe('a window closed on a partial reply', () => {
  it('closes at once, saying it continues and until when', async () => {
    const until = new Date(Date.now() + 60_000);
    routed.current = routedOutcome(continuedTurn(new Promise(() => undefined), until));
    const result = await routeWindow({ window: { ...window }, inputs: () => ({}) as never });
    expect(result.decision).toBe('answered');
    expect(closes[0]?.detail).toMatchObject({
      continuing: true,
      continuesUntil: until.toISOString(),
      messageId: 'm-partial',
    });
    expect(writes).toEqual([]);
  });

  it("records the rest's dropped blocks on the window once the rest settles", async () => {
    const rest = Promise.resolve<TurnOutcome>({
      kind: 'delivered',
      messageId: 'm-rest',
      droppedBlocks: DROPPED,
    });
    routed.current = routedOutcome(continuedTurn(rest, new Date(Date.now() + 60_000)));
    const result = await routeWindow({ window: { ...window }, inputs: () => ({}) as never });
    await result.continued;
    expect(writes).toEqual([
      {
        windowId: 'w-1',
        claim: { claimedAt: window.claimedAt, claimedBy: 'core-1' },
        continued: { decision: 'answered', messageId: 'm-rest', droppedBlocks: DROPPED },
      },
    ]);
  });

  it('records the rest as unsettled once its bound passes, rather than reading continuing for ever', async () => {
    routed.current = routedOutcome(
      continuedTurn(new Promise(() => undefined), new Date(Date.now() + 30)),
    );
    const result = await routeWindow({ window: { ...window }, inputs: () => ({}) as never });
    await result.continued;
    expect(writes[0]?.continued).toMatchObject({
      decision: 'undetermined',
      reason: 'the rest of the turn had not settled by the bound its record waits for',
    });
  });

  it('a window whose turn answered inside its first ceiling waits on nothing', async () => {
    routed.current = routedOutcome({ kind: 'delivered', messageId: 'm-1' });
    const result = await routeWindow({ window: { ...window }, inputs: () => ({}) as never });
    expect(result.continued).toBeUndefined();
    expect(closes[0]?.detail.continuing).toBeUndefined();
  });
});
