import { describe, expect, it, vi } from 'vitest';

const outboxRows: Array<{ type: string }> = [];
const frames: Array<{ userIds: readonly string[] | undefined; event: string }> = [];

vi.mock('../outbox/index.js', () => ({
  emitEvent: vi.fn(async (_tx: unknown, type: string) => {
    outboxRows.push({ type });
  }),
}));
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../conversations/index.js', () => ({
  listParticipants: async () => [{ kind: 'person', userId: 'u-1' }],
  assertConversationReadable: async () => undefined,
  findConversation: async () => null,
}));
vi.mock('../lib/ephemeral.js', () => ({
  publishEphemeral: (target: { userIds?: readonly string[] }, frame: { event: string }) => {
    frames.push({ userIds: target.userIds, event: frame.event });
  },
}));

const { ConversationProgress } = await import('./conversation-progress.js');

describe('a conversation progress frame is ephemeral', () => {
  it('reaches the room readers and writes no outbox row', async () => {
    const progress = new ConversationProgress('c-1', 'e-1');
    progress.onTurnEvent({ type: 'text', delta: 'hello' } as never);
    progress.onTurnEvent({ type: 'tool_call', id: 't-1', name: 'x', arguments: '{}' } as never);
    await progress.close();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.event === 'conversation.progress')).toBe(true);
    expect(frames[0]?.userIds).toEqual(['u-1']);
    expect(outboxRows).toEqual([]);
  });
});

describe('a turn is shown working before it has produced anything', () => {
  it('publishes an empty entry at once, and a continuation under its own entry', async () => {
    frames.length = 0;
    const started = Date.now();
    const progress = new ConversationProgress('c-1', 'e-2');
    progress.begin();
    const rest = progress.next();
    await progress.close();
    await rest.close();
    expect(frames).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(rest.entryId).not.toBe('e-2');
  });

  it('does not publish a second empty entry over one that already streamed', async () => {
    frames.length = 0;
    const progress = new ConversationProgress('c-1', 'e-3');
    progress.onTurnEvent({ type: 'tool_call', id: 't-1', name: 'x', arguments: '{}' } as never);
    progress.begin();
    await progress.close();
    expect(frames).toHaveLength(1);
  });
});
