import { OUTBOX_CONSUMERS } from '@forge/contracts/outbox-consumers';
import { emitsTransition } from '@forge/contracts/outbox-events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (payload: unknown) => unknown>();
const published: Array<{ room: string; event: string; data: unknown }> = [];

vi.mock('../outbox/index.js', () => ({
  consume: (type: string, consumer: { handle: (payload: unknown) => unknown }) => {
    handlers.set(type, consumer.handle);
  },
  emitEvent: vi.fn(),
}));
vi.mock('../lib/rooms.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/rooms.js')>();
  return {
    ...real,
    roomManager: {
      publish: (room: string, msg: { event: string; data: unknown }) => {
        published.push({ room, event: msg.event, data: msg.data });
        return 1;
      },
    },
  };
});

const { registerWsBroadcastSubscribers } = await import('./broadcast-subscribers.js');

describe('a question change reaches the open screens of its project', () => {
  beforeEach(() => {
    handlers.clear();
    published.length = 0;
    registerWsBroadcastSubscribers();
  });

  it('an ask is a question.changed frame in the project room', async () => {
    await handlers.get('question.asked')?.({ questionId: 'q1', projectId: 'p1', issueId: 'i1' });
    expect(published).toHaveLength(1);
    expect(published[0]?.event).toBe('question.changed');
    expect(published[0]?.data).toMatchObject({ questionId: 'q1', issueId: 'i1', change: 'asked' });
  });

  it.each(['answered', 'void', 'expired'])('a move to %s is told with its state', async (to) => {
    await handlers.get('question.transitioned')?.({ id: 'q1', projectId: 'p1', issueId: null, to });
    expect(published[0]?.data).toMatchObject({ questionId: 'q1', issueId: null, change: to });
  });

  it('the kernel emits an answer, a void and an expiry, and both events name ws-broadcast', () => {
    for (const to of ['answered', 'void', 'expired'])
      expect(emitsTransition('question', to)).toBe(true);
    expect(emitsTransition('question', 'open')).toBe(false);
    expect(OUTBOX_CONSUMERS['question.asked']).toContain('ws-broadcast');
    expect(OUTBOX_CONSUMERS['question.transitioned']).toContain('ws-broadcast');
  });
});
