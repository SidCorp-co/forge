import { describe, expect, it, vi } from 'vitest';
import { SEND_UNDELIVERED_DEADLINE_MS } from '../lib/session-send-deadline.js';

const reads = vi.hoisted(() => ({ queue: [] as unknown[][] }));

vi.mock('../db/client.js', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'innerJoin']) chain[m] = () => chain;
  chain.limit = async () => reads.queue.shift() ?? [];
  return { db: chain };
});

const { resolveSessionSend } = await import('./session-send.js');

const NOW = Date.parse('2026-10-07T12:00:00Z');
const row = (ageMs: number, extra: Record<string, unknown> = {}) =>
  ({
    agentSessionId: 's1',
    seq: 4,
    sendRequestedAt: new Date(NOW - ageMs),
    sendConfirmedAt: null,
    sendOutcome: null,
    appliedAt: null,
    ...extra,
  }) as never;

/** A live, non-terminal session on a box that beat a moment ago. */
const liveSession = () => {
  reads.queue = [[{ deviceId: 'd1', status: 'running' }], [{ lastSeenAt: new Date(NOW - 1000) }]];
};

describe('a send the live pane never confirmed', () => {
  it('is still unknown inside the deadline', async () => {
    liveSession();
    const r = await resolveSessionSend(row(SEND_UNDELIVERED_DEADLINE_MS - 60_000), NOW);
    expect(r.outcome).toBe('unknown');
  });

  it('resolves as undelivered past the deadline', async () => {
    liveSession();
    const r = await resolveSessionSend(row(SEND_UNDELIVERED_DEADLINE_MS + 60_000), NOW);
    expect(r.outcome).toBe('undelivered');
  });

  it('stays unknown once the agent applied it, however old', async () => {
    liveSession();
    const r = await resolveSessionSend(
      row(SEND_UNDELIVERED_DEADLINE_MS * 3, { appliedAt: new Date(NOW - 1) }),
      NOW,
    );
    expect(r.outcome).toBe('unknown');
    expect(r.applied).toBe(true);
  });

  it('is still gone when the box stopped beating', async () => {
    reads.queue = [
      [{ deviceId: 'd1', status: 'running' }],
      [{ lastSeenAt: new Date(NOW - 3_600_000) }],
    ];
    const r = await resolveSessionSend(row(SEND_UNDELIVERED_DEADLINE_MS * 2), NOW);
    expect(r.outcome).toBe('gone');
  });
});
