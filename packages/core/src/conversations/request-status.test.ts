import { beforeEach, describe, expect, it, vi } from 'vitest';

// ISS-875: a request is told core's line only where the agent could not answer (its turn failed),
// in the plain Vietnamese turn-failed line, once per thread; a silence the agent chose, a reply the
// check held, an empty turn and an uncertain delivery are told nothing.

const told = new Set<string>();
const delivered: { text: string; anchor: string | null | undefined }[] = [];

vi.mock('./last-resort.js', async () => {
  const { LAST_RESORT_LINES } =
    await vi.importActual<typeof import('./last-resort.js')>('./last-resort.js');
  return {
    LAST_RESORT_LINES,
    claimLastResort: async (place: { adapter: string; venue: string }, kind: 'turn_failed') => {
      const key = `${place.adapter}|${place.venue}`;
      if (told.has(key)) return null;
      told.add(key);
      return LAST_RESORT_LINES[kind];
    },
    releaseLastResort: async (place: { adapter: string; venue: string }) => {
      told.delete(`${place.adapter}|${place.venue}`);
    },
  };
});
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('./transcript.js', () => ({ recordDeliveredReply: async () => undefined }));
vi.mock('./window-claim.js', () => ({ reserveDelivery: async () => true }));
vi.mock('./presence.js', () => ({ namesHandle: () => true }));
vi.mock('./ports.js', async () => {
  const actual = await vi.importActual<typeof import('./ports.js')>('./ports.js');
  return {
    ...actual,
    conversationTransport: () => ({
      adapter: 'rocketchat',
      deliver: async (_v: unknown, m: { text: string }, o?: { anchor?: string | null }) => {
        delivered.push({ text: m.text, anchor: o?.anchor });
        return { messageId: `m-${delivered.length}` };
      },
      fetchHistory: async () => [],
      // a top-level request's line hangs under it, so the message opens its thread
      threadVenueOf: (venue: { externalId: string }, anchor: string | null) =>
        anchor ? `${venue.externalId} ${anchor}` : venue.externalId,
    }),
  };
});

const { withTerminalStatus, newRequestTrack } = await import('./request-status.js');
const { LAST_RESORT_LINES } = await import('./last-resort.js');

const venue = {
  adapter: 'rocketchat' as const,
  externalId: 'chat.test GROUP',
  shape: 'group' as const,
  projectId: 'p-1',
};

function track(anchor: string) {
  const t = newRequestTrack();
  t.venue = venue;
  t.anchor = { messageId: anchor, receivedAt: new Date(), authorLabel: 'alice', text: 'hello' };
  return t;
}

const args = (anchor: string) => ({
  window: { id: 'w-1', conversationId: 'c-1', projectId: 'p-1' },
  deliveryKey: 'window:w-1',
  claim: {} as never,
  track: track(anchor),
});

beforeEach(() => {
  told.clear();
  delivered.length = 0;
});

describe('the line a request is owed', () => {
  it('is the plain Vietnamese turn-failed line, with no code, where the turn failed', async () => {
    const routed = await withTerminalStatus(
      {
        decision: 'unreachable',
        detail: { code: 'ASSISTANT_TURN_FAILED', reason: 'forge could not reach its model' },
      },
      args('a-1'),
    );
    expect(delivered).toEqual([{ text: LAST_RESORT_LINES.turn_failed, anchor: 'a-1' }]);
    expect((routed.detail as unknown as { status: { delivered: boolean } }).status.delivered).toBe(
      true,
    );
  });

  it.each([
    ['a silence the turn chose', 'nothing-to-say', { reason: 'nothing-to-say' }],
    ['a reply the check held', 'nothing-to-say', { reason: 'screen-refused' }],
    ['a turn that wrote nothing', 'nothing-to-say', { reason: 'empty-reply' }],
    ['a delivery nobody can confirm', 'undetermined', { reason: 'r', attempted: true }],
  ] as const)(
    'is nothing for %s: core never stands in for the agent',
    async (_what, decision, detail) => {
      await withTerminalStatus({ decision, detail }, args('a-2'));
      expect(delivered).toEqual([]);
    },
  );

  it('is said once in a thread: a second failed request there is told nothing', async () => {
    await withTerminalStatus({ decision: 'unreachable', detail: {} }, args('a-3'));
    const again = await withTerminalStatus({ decision: 'unreachable', detail: {} }, args('a-3'));
    expect(delivered).toHaveLength(1);
    expect((again.detail as { status: { reason: string } }).status.reason).toContain(
      'told its one last-resort line already',
    );
    // another request at the room's top level opens a thread of its own
    await withTerminalStatus({ decision: 'unreachable', detail: {} }, args('a-4'));
    expect(delivered).toHaveLength(2);
  });
});
