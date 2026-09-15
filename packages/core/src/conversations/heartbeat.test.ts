import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: {} }));
vi.mock('../db/client.js', () => ({ db: {} }));

import { type HeartbeatFacts, heartbeatDue } from './heartbeat.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
let seq = 0;
const msg = (who: 'person' | 'agent', msAgo: number) =>
  ({
    id: `m${++seq}`,
    seq,
    role: who === 'agent' ? 'assistant' : 'user',
    authorUserId: who === 'agent' ? 'handle-1' : 'alice',
    content: 'x',
    createdAt: ago(msAgo),
  }) as unknown as HeartbeatFacts['messages'][number];

const facts = (over: Partial<HeartbeatFacts> = {}): HeartbeatFacts => ({
  lastSettledDecision: 'nothing-to-say',
  windowOpen: false,
  messages: [msg('agent', 3 * HOUR), msg('person', 2 * HOUR), msg('person', 90 * 60 * 1000)],
  agentUserIds: new Set(['handle-1']),
  lastHeartbeatAt: null,
  intervalMs: HOUR,
  now: NOW,
  ...over,
});

describe('heartbeatDue', () => {
  // cm:guard the range is asserted as the FIRST unanswered person message to the newest — two person messages after the agent's last word, both in the window — because a range read from the collector's watermark would hold none of them (ISS-1034 criterion 36).
  it('is due over every person message since the agent last spoke', () => {
    const f = facts();
    const [, first, newest] = f.messages;
    expect(heartbeatDue(f)).toEqual({ due: true, firstSeq: first?.seq, lastSeq: newest?.seq });
  });

  it('is due when the agent has never spoken at all', () => {
    const f = facts({ messages: [msg('person', 2 * HOUR)] });
    expect(heartbeatDue(f)).toMatchObject({ due: true, firstSeq: f.messages[0]?.seq });
  });

  it('is not due while a window is collecting or claimed', () => {
    expect(heartbeatDue(facts({ windowOpen: true }))).toEqual({
      due: false,
      reason: 'window-open',
    });
  });

  it('is not due unless the last settled window found nothing to say', () => {
    for (const decision of ['answered', 'guard-backoff', null] as const) {
      expect(heartbeatDue(facts({ lastSettledDecision: decision }))).toEqual({
        due: false,
        reason: 'last-window-not-quiet',
      });
    }
  });

  it('is not due when the newest message is the agent’s own', () => {
    const f = facts({ messages: [msg('person', 2 * HOUR), msg('agent', HOUR)] });
    expect(heartbeatDue(f)).toEqual({ due: false, reason: 'newest-not-a-person' });
  });

  it('is not due while the agent spoke within the interval', () => {
    const f = facts({ messages: [msg('agent', 30 * 60 * 1000), msg('person', 60 * 1000)] });
    expect(heartbeatDue(f)).toEqual({ due: false, reason: 'agent-spoke-recently' });
  });

  // cm:guard the interval is measured against the LAST heartbeat as well as the last agent message: a heartbeat window that decided nothing-to-say left no agent message, and without this clause the next tick would open another every time (ISS-1034 criterion 36).
  it('is not due while the last heartbeat is within the interval', () => {
    expect(heartbeatDue(facts({ lastHeartbeatAt: ago(30 * 60 * 1000) }))).toEqual({
      due: false,
      reason: 'heartbeat-recent',
    });
    expect(heartbeatDue(facts({ lastHeartbeatAt: ago(2 * HOUR) }))).toMatchObject({ due: true });
  });

  it('is not due in a room with no messages', () => {
    expect(heartbeatDue(facts({ messages: [] }))).toEqual({ due: false, reason: 'no-messages' });
  });

  it('counts a handle’s own user message as the agent’s', () => {
    const f = facts({
      messages: [
        msg('person', 2 * HOUR),
        {
          ...msg('person', 90 * 60 * 1000),
          role: 'user',
          authorUserId: 'handle-1',
        } as unknown as HeartbeatFacts['messages'][number],
      ],
    });
    expect(heartbeatDue(f)).toEqual({ due: false, reason: 'newest-not-a-person' });
  });
});
