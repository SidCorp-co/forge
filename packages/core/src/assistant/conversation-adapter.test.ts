/**
 * ISS-1004 step 5 — the Forge UI's four ports.
 *
 * The one that can be got wrong in a way no screen would show is `deliver`:
 * a fan-out to the project room renders identically in the tab that asked and
 * hands every member of the project somebody else's chat. So the assertions
 * here are about WHICH rooms were published to, and the room list is the
 * subject rather than the payload.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const published: Array<{ room: string; event: string; data: unknown }> = [];

vi.mock('../ws/room-manager.js', () => ({
  roomManager: {
    publish: (room: string, envelope: { event: string; data: unknown }) => {
      published.push({ room, event: envelope.event, data: envelope.data });
      return 1;
    },
  },
}));

const findConversation = vi.fn();
const listParticipants = vi.fn();
const assertConversationReadable = vi.fn();

vi.mock('../conversations/store.js', () => ({
  findConversation: (...args: unknown[]) => findConversation(...args),
}));
vi.mock('../conversations/participants.js', () => ({
  listParticipants: (...args: unknown[]) => listParticipants(...args),
}));
vi.mock('../conversations/scope.js', () => ({
  assertConversationReadable: (...args: unknown[]) => assertConversationReadable(...args),
}));

const { WEB_CONVERSATION_EVENT, webConversationPorts } = await import('./conversation-adapter.js');

const venue = {
  adapter: 'web' as const,
  externalId: 'venue-1',
  shape: 'direct' as const,
  projectId: 'project-1',
};

beforeEach(() => {
  published.length = 0;
  findConversation.mockReset();
  listParticipants.mockReset();
  assertConversationReadable.mockReset();
  assertConversationReadable.mockResolvedValue(['project-1']);
  findConversation.mockResolvedValue({ id: 'conv-1', adapter: 'web', externalId: 'venue-1' });
  listParticipants.mockResolvedValue([
    { kind: 'person', userId: 'alice' },
    { kind: 'person', userId: 'bob' },
    { kind: 'handle', userId: 'agent-1' },
    { kind: 'person', userId: null, externalKey: 'someone@elsewhere' },
  ]);
});

describe('the Forge UI adapter · deliver', () => {
  it('publishes to each live person’s own user room and to no other room', async () => {
    const receipt = await webConversationPorts.deliver(venue, { text: 'hello', problems: [] });

    expect(published.map((p) => p.room).sort()).toEqual(['user:alice', 'user:bob']);
    expect(published.every((p) => p.event === WEB_CONVERSATION_EVENT)).toBe(true);
    expect(receipt.messageId).toEqual(expect.any(String));
  });

  it('publishes to no project room', async () => {
    await webConversationPorts.deliver(venue, { text: 'hello', problems: [] });
    expect(published.filter((p) => p.room.startsWith('project:'))).toEqual([]);
  });

  it('carries the text and the screen’s verdict, so a tab renders without reading back', async () => {
    await webConversationPorts.deliver(venue, { text: 'the answer', problems: ['softened'] });
    expect(published[0]?.data).toMatchObject({
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'the answer',
      problems: ['softened'],
    });
  });

  it('publishes to nobody whose access to the room has gone', async () => {
    assertConversationReadable.mockImplementation(async (_id: string, userId: string) => {
      if (userId === 'bob') throw new Error('no role on this project any more');
      return ['project-1'];
    });
    await webConversationPorts.deliver(venue, { text: 'hello', problems: [] });
    expect(published.map((p) => p.room)).toEqual(['user:alice']);
  });

  it('refuses by name when the room went while the turn ran', async () => {
    findConversation.mockResolvedValue(null);
    await expect(
      webConversationPorts.deliver(venue, { text: 'hello', problems: [] }),
    ).rejects.toThrow(/no conversation is open at web venue "venue-1"/);
    expect(published).toEqual([]);
  });

  it('delivers to a room nobody has open without calling it a failure', async () => {
    listParticipants.mockResolvedValue([{ kind: 'handle', userId: 'agent-1' }]);
    await expect(
      webConversationPorts.deliver(venue, { text: 'hello', problems: [] }),
    ).resolves.toMatchObject({ messageId: expect.any(String) });
    expect(published).toEqual([]);
  });
});

describe('the Forge UI adapter · the other three ports', () => {
  it('places the venue from the room the route already read', async () => {
    const resolved = await webConversationPorts.resolveVenue({
      conversation: { id: 'conv-1', externalId: 'venue-1', shape: 'direct' },
      projectId: 'project-1',
      userId: 'alice',
    });
    expect(resolved).toEqual(venue);
  });

  it('links the signed-in reader with no directory lookup', async () => {
    const speaker = await webConversationPorts.resolveSpeaker({
      conversation: { id: 'conv-1', externalId: 'venue-1', shape: 'direct' },
      projectId: 'project-1',
      userId: 'alice',
    });
    expect(speaker).toEqual({ linked: true, userId: 'alice' });
  });

  it('fetches no history, because the store is this transport’s history', async () => {
    expect(await webConversationPorts.fetchHistory(venue, 50)).toEqual([]);
    expect(findConversation).not.toHaveBeenCalled();
  });
});
