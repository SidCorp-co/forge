import { OUTBOX_CONSUMERS } from '@forge/contracts/outbox-consumers';
import { emitsTransition } from '@forge/contracts/outbox-events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (payload: unknown) => unknown>();
const published: Array<{ room: string; event: string; data: unknown }> = [];

vi.mock('../outbox/index.js', () => ({
  // the room frames of each event, not the org room's own delivery beside them
  consume: (type: string, consumer: { name: string; handle: (payload: unknown) => unknown }) => {
    if (consumer.name !== 'org-activity') handlers.set(type, consumer.handle);
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

  it.each(['void', 'expired'])('a move to %s is told with its state', async (to) => {
    await handlers.get('question.transitioned')?.({ id: 'q1', projectId: 'p1', issueId: null, to });
    expect(published[0]?.data).toMatchObject({ questionId: 'q1', issueId: null, change: to });
  });

  it('an answer is told once, by its own event, with the state it reached (ISS-1181)', async () => {
    await handlers.get('question.answered')?.({ questionId: 'q1', projectId: 'p1', issueId: 'i1' });
    expect(published).toEqual([
      {
        room: 'project:p1',
        event: 'question.changed',
        data: { questionId: 'q1', projectId: 'p1', issueId: 'i1', change: 'answered' },
      },
    ]);
  });

  it('the kernel emits a void and an expiry, never the answer its own event reports, and each event names ws-broadcast', () => {
    for (const to of ['void', 'expired']) expect(emitsTransition('question', to)).toBe(true);
    for (const to of ['open', 'answered']) expect(emitsTransition('question', to)).toBe(false);
    expect(OUTBOX_CONSUMERS['question.asked']).toContain('ws-broadcast');
    expect(OUTBOX_CONSUMERS['question.transitioned']).toContain('ws-broadcast');
    expect(OUTBOX_CONSUMERS['question.answered']).toContain('ws-broadcast');
  });
});
