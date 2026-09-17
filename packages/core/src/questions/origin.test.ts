/**
 * ISS-1091 — what a question remembers about where it was asked.
 *
 * The three answers are the whole point of this module, and the one that is
 * easy to lose is the third: a session that names a conversation whose venue
 * cannot be read must NOT look like a session that names no conversation at
 * all, because the second is delivered to the project's bound room and the
 * first must be delivered nowhere.
 */

import { describe, expect, it, vi } from 'vitest';
import { CONVERSATION_AGENT_MARKER } from '../agent-sessions/conversation-agent.js';
import { resolveAskOrigin } from './origin.js';

/** One executor that answers a queued row set per select, in call order. */
function executorOf(...results: unknown[][]) {
  let call = 0;
  const next = () => results[call++] ?? [];
  const chain = {
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(next()),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve),
  };
  return { select: vi.fn(() => ({ from: () => chain })) } as never;
}

const marker = (over: Record<string, unknown> = {}) => ({
  [CONVERSATION_AGENT_MARKER]: {
    venue: { adapter: 'rocketchat', externalId: 'chat.example.co GENERAL', projectId: 'p-1' },
    conversationId: 'c-1',
    windowId: 'w-1',
    deliveryKey: 'd-1',
    ...over,
  },
});

describe('resolveAskOrigin', () => {
  it('answers null when the ask names no session at all', async () => {
    expect(await resolveAskOrigin(executorOf(), undefined)).toBeNull();
  });

  it('answers null when the session carries no conversation marker', async () => {
    const origin = await resolveAskOrigin(executorOf([{ metadata: { lensOverride: ['product'] } }]), 's-1');
    expect(origin).toBeNull();
  });

  it('answers unresolved, not null, when a marker is present and unreadable', async () => {
    const origin = await resolveAskOrigin(
      executorOf([{ metadata: { [CONVERSATION_AGENT_MARKER]: { conversationId: 'c-1' } } }]),
      's-1',
    );
    expect(origin?.kind).toBe('unresolved');
    expect(origin?.kind === 'unresolved' && origin.reason).toContain('venue');
  });

  it('answers unresolved when the window the marker names is gone', async () => {
    const origin = await resolveAskOrigin(executorOf([{ metadata: marker() }], []), 's-1');
    expect(origin?.kind).toBe('unresolved');
    expect(origin?.kind === 'unresolved' && origin.reason).toContain('w-1');
  });

  it('answers unresolved when the window holds no inbound message', async () => {
    const origin = await resolveAskOrigin(
      executorOf([{ metadata: marker() }], [{ firstSeq: 1, lastSeq: 4 }], []),
      's-1',
    );
    expect(origin?.kind).toBe('unresolved');
    expect(origin?.kind === 'unresolved' && origin.reason).toContain('anchored');
  });

  it('takes the anchor and the asker off the window last inbound message', async () => {
    const origin = await resolveAskOrigin(
      executorOf(
        [{ metadata: marker() }],
        [{ firstSeq: 1, lastSeq: 9 }],
        [{ externalId: 'm-9', authorUserId: 'u-9', authorLabel: 'dao', authorKey: 'rc-9' }],
      ),
      's-1',
    );
    expect(origin).toEqual({
      kind: 'conversation',
      adapter: 'rocketchat',
      venueId: 'chat.example.co GENERAL',
      conversationId: 'c-1',
      windowId: 'w-1',
      anchorId: 'm-9',
      askedByUserId: 'u-9',
      askedByLabel: 'dao',
      askedByKey: 'rc-9',
    });
  });

  it('falls back to the marker label only where the message carries none', async () => {
    const origin = await resolveAskOrigin(
      executorOf(
        [{ metadata: marker({ askedByLabel: 'from-the-marker' }) }],
        [{ firstSeq: 1, lastSeq: 9 }],
        [{ externalId: 'm-9', authorUserId: null, authorLabel: null, authorKey: 'rc-9' }],
      ),
      's-1',
    );
    expect(origin?.kind === 'conversation' && origin.askedByLabel).toBe('from-the-marker');
  });
});
