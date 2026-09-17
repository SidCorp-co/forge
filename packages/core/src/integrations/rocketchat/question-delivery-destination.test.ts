/**
 * ISS-1091 — what `deliverOwedRound` does with the destination it is handed.
 *
 * Three things here cannot be read off the resolver's own tests: that a refused
 * round posts NOTHING and still tells the operator why, that an anchored round
 * takes its thread before it posts and gives it back when the post fails, and
 * that a room this bot has been removed from is a destination rather than a
 * flake to retry eight times and forget.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const question = vi.fn<() => unknown[]>(() => []);
const project = vi.fn<() => unknown[]>(() => [
  { slug: 'acme', name: 'Acme', createdBy: 'u-owner' },
]);
const updates: Array<Record<string, unknown>> = [];
let joined = false;
vi.mock('../../db/client.js', () => {
  const selectChain: Record<string, unknown> = {
    innerJoin: () => {
      joined = true;
      return selectChain;
    },
    where: () => selectChain,
    limit: () => Promise.resolve(joined ? project() : question()),
  };
  const updateChain = {
    set: (v: Record<string, unknown>) => {
      updates.push(v);
      return { where: () => Promise.resolve([]) };
    },
  };
  return {
    db: {
      select: () => ({
        from: () => {
          joined = false;
          return selectChain;
        },
      }),
      update: () => updateChain,
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({ returning: () => Promise.resolve([{ id: 'd-1' }]) }),
        }),
      }),
    },
  };
});

const destination = vi.fn<() => Promise<unknown>>();
const isUnreachableRoom = vi.fn<(e: unknown) => boolean>(() => false);
vi.mock('./question-destination.js', () => ({
  resolveQuestionDestination: () => destination(),
  isUnreachableRoom: (e: unknown) => isUnreachableRoom(e),
}));

const sendFixedReply = vi.fn<() => Promise<{ messageId: string | null }>>(async () => ({
  messageId: 'posted-1',
}));
vi.mock('./outbound.js', () => ({
  FIXED_REPLY_CONSTANT: Symbol('fixed'),
  sendFixedReply: () => sendFixedReply(),
}));

const registerThread = vi.fn<() => Promise<boolean>>(async () => true);
const releaseQuestionThread = vi.fn<() => Promise<boolean>>(async () => true);
vi.mock('./thread-registry.js', () => ({
  registerThread: (...a: unknown[]) => registerThread(...(a as [])),
  releaseQuestionThread: (...a: unknown[]) => releaseQuestionThread(...(a as [])),
}));

vi.mock('./room-delivery.js', () => ({
  resolveRoomPostAuth: async () => ({ serverUrl: 'https://c', authToken: 't', userId: 'bot' }),
}));

vi.mock('../../messaging/screen.js', () => ({ screenAtDoor: () => ({ ok: true, problems: [] }) }));
vi.mock('../../messaging/contract.js', () => ({ problemsOf: () => [] }));
vi.mock('./question-render.js', () => ({
  agentAuthoredSegments: () => [],
  renderRound: () => 'the round',
}));
vi.mock('../../issues/issue-prefix-read.js', () => ({ activeIssuePrefix: async () => 'ISS' }));
vi.mock('../../lib/issue-ref.js', () => ({ formatIssueRef: () => 'ISS-1' }));

const emitNotification = vi.fn<() => Promise<void>>(async () => {});
vi.mock('../../notifications/emit.js', () => ({ emitNotification: (a: unknown) => emitNotification(a as never) }));
vi.mock('../../notifications/auto-resolve.js', () => ({ resolveNotifications: async () => {} }));

const { deliverOwedRound } = await import('./question-delivery.js');

const owed = { questionId: 'q-1', projectId: 'p-1', issueId: null, round: 1, attempts: 0, wasUndeliverable: false };
const row = {
  id: 'q-1',
  steps: [{ round: 1, prompt: 'p', askedAt: 'now', answerShape: 'free_text', needed: 'x' }],
  origin: null,
  parkDeadlineAt: null,
};

beforeEach(() => {
  updates.length = 0;
  question.mockReturnValue([row]);
  sendFixedReply.mockResolvedValue({ messageId: 'posted-1' });
  registerThread.mockResolvedValue(true);
  releaseQuestionThread.mockResolvedValue(true);
  isUnreachableRoom.mockReturnValue(false);
  emitNotification.mockClear();
  registerThread.mockClear();
  releaseQuestionThread.mockClear();
  sendFixedReply.mockClear();
});

describe('deliverOwedRound', () => {
  it('posts nothing and tells the operator the reason when the destination is unresolvable', async () => {
    destination.mockResolvedValue({ kind: 'unresolvable', reason: 'nobody to ask' });
    expect(await deliverOwedRound(owed)).toBe('undeliverable');
    expect(sendFixedReply).not.toHaveBeenCalled();
    expect(updates.some((u) => u.status === 'undeliverable' && u.lastError === 'nobody to ask')).toBe(true);
    expect(emitNotification).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('nobody to ask') }),
    );
  });

  it('takes the anchor BEFORE it posts', async () => {
    const order: string[] = [];
    registerThread.mockImplementation(async () => {
      order.push('take');
      return true;
    });
    sendFixedReply.mockImplementation(async () => {
      order.push('post');
      return { messageId: 'posted-1' };
    });
    destination.mockResolvedValue({
      kind: 'room',
      connectionId: 'c1',
      rid: 'ROOMA',
      tmid: 'm-9',
      takeAnchor: true,
    });
    expect(await deliverOwedRound(owed)).toBe('delivered');
    expect(order[0]).toBe('take');
    expect(order[1]).toBe('post');
  });

  it('refuses without posting when the anchor belongs to another subject', async () => {
    registerThread.mockResolvedValue(false);
    destination.mockResolvedValue({
      kind: 'room',
      connectionId: 'c1',
      rid: 'ROOMA',
      tmid: 'm-9',
      takeAnchor: true,
    });
    expect(await deliverOwedRound(owed)).toBe('undeliverable');
    expect(sendFixedReply).not.toHaveBeenCalled();
    expect(updates.some((u) => typeof u.lastError === 'string' && (u.lastError as string).includes('m-9'))).toBe(true);
  });

  it('gives the anchor back when the post then fails', async () => {
    sendFixedReply.mockRejectedValue(new Error('boom'));
    destination.mockResolvedValue({
      kind: 'room',
      connectionId: 'c1',
      rid: 'ROOMA',
      tmid: 'm-9',
      takeAnchor: true,
    });
    expect(await deliverOwedRound(owed)).toBe('failed');
    expect(releaseQuestionThread).toHaveBeenCalledWith('q-1', {
      connectionId: 'c1',
      rid: 'ROOMA',
      tmid: 'm-9',
    });
  });

  it('holds on to a thread it did not take this attempt', async () => {
    sendFixedReply.mockRejectedValue(new Error('boom'));
    destination.mockResolvedValue({
      kind: 'room',
      connectionId: 'c1',
      rid: 'ROOMA',
      tmid: 'm-9',
      takeAnchor: false,
    });
    await deliverOwedRound(owed);
    expect(releaseQuestionThread).not.toHaveBeenCalled();
  });

  it('settles a room this bot cannot post in undeliverable, not as a retryable failure', async () => {
    sendFixedReply.mockRejectedValue(new Error('chat.postMessage rejected: error-not-allowed'));
    isUnreachableRoom.mockReturnValue(true);
    destination.mockResolvedValue({
      kind: 'room',
      connectionId: 'c1',
      rid: 'ROOMA',
      tmid: null,
      takeAnchor: false,
    });
    expect(await deliverOwedRound(owed)).toBe('undeliverable');
    expect(emitNotification).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('ROOMA') }),
    );
  });

  it('still delivers a question with no origin to the room it is handed', async () => {
    destination.mockResolvedValue({
      kind: 'room',
      connectionId: 'c1',
      rid: 'PROJ',
      tmid: null,
      takeAnchor: false,
    });
    expect(await deliverOwedRound(owed)).toBe('delivered');
    expect(registerThread).toHaveBeenCalledWith(
      { questionId: 'q-1' },
      { connectionId: 'c1', rid: 'PROJ', tmid: 'posted-1' },
    );
  });
});
