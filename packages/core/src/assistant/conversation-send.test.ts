/**
 * ISS-1004 step 5 — what a send claims, and what the recovery drain claims.
 *
 * The two calls look alike and must not be: a send is about ONE room and settles
 * at zero because the person already pressed enter, and the drain is about
 * whatever a stopped core left and settles the ordinary way. Swap either half
 * and every screen still works — a send simply answers somebody else's room, or
 * waits four seconds for a message it was told was finished. So the claim's own
 * arguments are the subject here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const collectInboundMessage = vi.fn();
const claimDueWindows = vi.fn();
const routeWindow = vi.fn();
const releaseWindow = vi.fn();
const resolveProjectHandle = vi.fn();
const published: Array<{ event: string; data: unknown }> = [];
const publishFails = { value: false };

vi.mock('../conversations/collect-inbound.js', () => ({
  collectInboundMessage: (...a: unknown[]) => collectInboundMessage(...a),
}));
vi.mock('../conversations/route-window.js', () => ({
  routeWindow: (...a: unknown[]) => routeWindow(...a),
}));
vi.mock('../conversations/windows.js', () => ({
  claimDueWindows: (...a: unknown[]) => claimDueWindows(...a),
  claimOf: (row: { claimedAt: Date | null; claimedBy: string | null }) =>
    row.claimedAt && row.claimedBy ? { claimedAt: row.claimedAt, claimedBy: row.claimedBy } : null,
  releaseWindow: (...a: unknown[]) => releaseWindow(...a),
}));
vi.mock('./conversation-adapter.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    publishToConversationReaders: async (
      _id: string,
      envelope: { event: string; data: unknown },
    ) => {
      if (publishFails.value) throw new Error('no room manager here');
      published.push(envelope);
      return 1;
    },
  };
});
vi.mock('../conversations/handles.js', () => ({
  resolveProjectHandle: (...a: unknown[]) => resolveProjectHandle(...a),
}));
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ id: 'p1', slug: 'alpha', name: 'Alpha' }] }),
      }),
    }),
  },
}));
vi.mock('./tools/registry.js', () => ({ buildProjectToolset: () => ({ tools: [] }) }));
vi.mock('./tools/principal.js', () => ({ buildChatToolContext: (a: unknown) => a }));

const { webConversationPersona } = await import('./door-persona.js');
const { sendWebConversationMessage, drainWebConversationWindows } = await import(
  './conversation-send.js'
);

const room = { id: 'conv-1', externalId: 'venue-1', shape: 'direct' as const };

const claimed = {
  id: 'win-1',
  conversationId: 'conv-1',
  projectId: 'p1',
  adapter: 'web',
  claimedAt: new Date(),
  claimedBy: 'someone',
  firstSeq: 0,
  lastSeq: 0,
};

beforeEach(() => {
  published.length = 0;
  publishFails.value = false;
  for (const m of [
    collectInboundMessage,
    claimDueWindows,
    routeWindow,
    releaseWindow,
    resolveProjectHandle,
  ])
    m.mockReset();
  collectInboundMessage.mockResolvedValue({
    kind: 'collected',
    conversationId: 'conv-1',
    windowId: 'win-1',
    messageId: 'msg-1',
    seq: 3,
  });
  claimDueWindows.mockResolvedValue([claimed]);
  routeWindow.mockResolvedValue({ decision: 'answered' });
  resolveProjectHandle.mockResolvedValue({
    userId: 'agent-1',
    handle: 'agent-alpha',
    minted: false,
  });
});

const send = (extra: { clientToken?: string } = {}) =>
  sendWebConversationMessage({
    room,
    projectId: 'p1',
    userId: 'alice',
    userLabel: 'Alice',
    content: 'how are the issues doing?',
    mode: 'assistant' as const,
    namedMode: false,
    ...extra,
  });

const accepted = {
  event: 'conversation.accepted',
  data: {
    conversationId: 'conv-1',
    messageId: 'msg-1',
    seq: 3,
    clientToken: null,
  },
};

describe('a send', () => {
  // cm:guard the venue prefix is what keeps one person's request off another room's window; without it this call takes whatever the adapter owes and answers it under this request's timing.
  it('claims only this room’s window, and does not wait out the settle', async () => {
    await send();
    expect(claimDueWindows).toHaveBeenCalledTimes(1);
    expect(claimDueWindows.mock.calls[0]?.[0]).toMatchObject({
      adapter: 'web',
      limit: 1,
      settleMs: 0,
      venuePrefixes: ['venue-1'],
    });
  });

  // cm:guard the settle event is published AFTER `routeWindow` returns, which is the whole reason it exists beside the delivery event: the delivery goes out before the reply row commits, so a second tab that refetched on that alone reads the room back without the answer in it (review F2).
  it('tells the room it has settled, after the window closed and whatever it decided', async () => {
    routeWindow.mockImplementation(async () => {
      // cm:guard the ACCEPTED frame is the only thing out at this point and the settled one is not:
      // acceptance says the question is durable, settlement says the room stopped thinking, and a
      // tab that read the second before it happened would stop waiting for the answer (ISS-1078).
      expect(published).toEqual([accepted]);
      return { decision: 'guard-dormant' };
    });
    await send();
    expect(published).toEqual([
      accepted,
      {
        event: 'conversation.settled',
        data: { conversationId: 'conv-1', windowId: 'win-1', decision: 'guard-dormant' },
      },
    ]);
  });

  // cm:guard this is criterion 1: the frame goes out BEFORE the turn is routed, because the whole
  // defect is that the POST does not return until the turn is over and until then nothing told the
  // screen the message was filed.
  it('tells the room the message is filed before the turn is routed', async () => {
    const seenAtRoute: Array<{ event: string; data: unknown }> = [];
    routeWindow.mockImplementation(async () => {
      seenAtRoute.push(...published);
      return { decision: 'answered' };
    });
    await send();
    expect(seenAtRoute).toEqual([accepted]);
  });

  // cm:guard criterion 2's other half: two tabs may each hold a message in flight in one room, and
  // an acceptance matched on the room alone would clear the wrong tab's unsent copy. The token is
  // the caller's own id, echoed back untouched.
  it('echoes the caller’s own token on the accepted frame', async () => {
    await send({ clientToken: 'outbox-42' });
    expect(published[0]).toEqual({
      event: 'conversation.accepted',
      data: {
        conversationId: 'conv-1',
        messageId: 'msg-1',
        seq: 3,
        clientToken: 'outbox-42',
      },
    });
  });

  // cm:guard a send whose acceptance nobody could be told about is still a send: the row is in the
  // log whether or not a socket was open, and turning a best-effort push into a failed request
  // would refuse a message that had already been committed.
  it('takes the turn even when the accepted frame cannot be published', async () => {
    publishFails.value = true;
    await expect(send()).resolves.toMatchObject({ decision: 'answered' });
    expect(routeWindow).toHaveBeenCalledTimes(1);
  });

  // cm:guard the two events that predate this change keep their names and their payloads, so a tab
  // running older code works exactly as it did — which is what makes the new frame additive.
  it('leaves conversation.settled’s name and payload alone', async () => {
    await send();
    expect(published.at(-1)).toEqual({
      event: 'conversation.settled',
      data: { conversationId: 'conv-1', windowId: 'win-1', decision: 'answered' },
    });
  });

  it('returns the decision the window settled on', async () => {
    routeWindow.mockResolvedValue({ decision: 'nothing-to-say' });
    await expect(send()).resolves.toMatchObject({
      windowId: 'win-1',
      seq: 3,
      decision: 'nothing-to-say',
    });
  });

  it('takes the message in before it is answered', async () => {
    await send();
    expect(collectInboundMessage).toHaveBeenCalledTimes(1);
    expect(collectInboundMessage.mock.calls[0]?.[0]).toMatchObject({
      message: 'how are the issues doing?',
      speakerKey: 'alice',
      speakerLabel: 'Alice',
      manySpeakersPrincipalUserId: 'alice',
    });
  });

  it('refuses by name when the room cannot be placed as a venue', async () => {
    collectInboundMessage.mockResolvedValue({ kind: 'venue-unresolved' });
    await expect(send()).rejects.toThrow(/could not be placed as a venue/);
    expect(claimDueWindows).not.toHaveBeenCalled();
  });

  it('says nothing was decided when another holder already has the window', async () => {
    claimDueWindows.mockResolvedValue([]);
    await expect(send()).resolves.toMatchObject({ decision: null });
    expect(routeWindow).not.toHaveBeenCalled();
  });
});

describe('the recovery drain', () => {
  it('claims by adapter, with the ordinary settle and no room of its own', async () => {
    await drainWebConversationWindows();
    const args = claimDueWindows.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args).toMatchObject({ adapter: 'web' });
    expect(args.venuePrefixes).toBeUndefined();
    expect(args.settleMs).toBeUndefined();
  });

  it('releases a window whose project is gone rather than closing it', async () => {
    vi.resetModules();
    vi.doMock('../db/client.js', () => ({
      db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) },
    }));
    const fresh = await import('./conversation-send.js');
    await fresh.drainWebConversationWindows();
    expect(releaseWindow).toHaveBeenCalledWith('win-1', {
      claimedAt: claimed.claimedAt,
      claimedBy: 'someone',
    });
    expect(routeWindow).not.toHaveBeenCalled();
  });
});

describe('the persona', () => {
  // cm:guard the Forge UI chat WAS a runner-hosted session with the repository checked out and is now a conversation turn with neither; a persona that did not say so would answer a question about a file as though it had looked (ISS-1004 step 5).
  it('says it has no checkout and no shell', () => {
    const persona = webConversationPersona('Alpha', 'alpha', 'Alice');
    expect(persona).toMatch(/no checkout of the repository and no shell/);
  });
});
