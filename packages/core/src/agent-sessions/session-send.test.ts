/**
 * RFC 0003 — send-episode resolution. The whole point of these cases is that
 * `unknown` survives: every path that a binary outcome would have collapsed
 * into `gone` is asserted to stay `unknown` instead.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (...args: unknown[]) => ({ _eq: args }),
  sql: Object.assign(() => ({ _sql: true }), { raw: () => ({ _sql: true }) }),
}));

vi.mock('../db/schema.js', () => ({
  agentSessions: { id: 'id', deviceId: 'device_id', lastInboxSeq: 'last_inbox_seq' },
  jobs: 'jobs-table',
  runners: { deviceId: 'device_id', lastSeenAt: 'last_seen_at' },
  sessionInbox: { agentSessionId: 'sid', kind: 'kind', intentId: 'iid', seq: 'seq', id: 'id' },
}));

const selectQueue: unknown[][] = [];
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => selectQueue.shift() ?? [] }) }),
    }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
  },
}));

vi.mock('../jobs/intervention-event.js', () => ({ insertInterventionEvent: vi.fn() }));
vi.mock('../lib/dispatch-liveness.js', () => ({ dispatchLivenessMs: () => 60_000 }));
vi.mock('../ws/rooms.js', () => ({ deviceRoom: (id: string) => `device:${id}` }));
vi.mock('../ws/server.js', () => ({ roomManager: { publish: vi.fn() } }));

const { isSendEpisodeLive, resolveSessionSend, sendEpisodeWindowMs, sendGraceMs } = await import(
  './session-send.js'
);

const NOW = 1_700_000_000_000;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inbox-1',
    agentSessionId: 'sess-1',
    seq: 4,
    kind: 'answer',
    intentId: 'comment-9',
    body: 'yes',
    sendRequestedAt: new Date(NOW),
    sendConfirmedAt: null,
    sendOutcome: null,
    appliedAt: null,
    appliedTurn: null,
    ...overrides,
  } as Parameters<typeof resolveSessionSend>[0];
}

beforeEach(() => {
  selectQueue.length = 0;
  delete process.env.SESSION_SEND_ACK_MS;
});

describe('sendGraceMs', () => {
  it('floors a low override instead of honouring it', () => {
    process.env.SESSION_SEND_ACK_MS = '5';
    expect(sendGraceMs()).toBe(10_000);
  });

  it('honours an override at or above the floor', () => {
    process.env.SESSION_SEND_ACK_MS = '3000';
    expect(sendGraceMs()).toBe(3000);
  });
});

describe('isSendEpisodeLive', () => {
  it('is live inside the window and dead one millisecond past it', () => {
    const r = row();
    expect(isSendEpisodeLive(r, NOW + sendEpisodeWindowMs())).toBe(true);
    expect(isSendEpisodeLive(r, NOW + sendEpisodeWindowMs() + 1)).toBe(false);
  });
});

describe('resolveSessionSend', () => {
  it('returns the runner answer given inside the episode', async () => {
    const r = row({ sendConfirmedAt: new Date(NOW + 100), sendOutcome: 'delivered' });
    await expect(resolveSessionSend(r, NOW + 200)).resolves.toEqual({
      outcome: 'delivered',
      applied: false,
    });
  });

  it('stays unknown while the episode is live and the runner is silent', async () => {
    await expect(resolveSessionSend(row(), NOW + 100)).resolves.toEqual({
      outcome: 'unknown',
      applied: false,
    });
  });

  it('refuses to read an answer whose episode has aged out', async () => {
    selectQueue.push([{ deviceId: 'dev-1' }], [{ lastSeenAt: new Date(NOW) }]);
    const r = row({ sendConfirmedAt: new Date(NOW + 100), sendOutcome: 'delivered' });
    const past = NOW + sendEpisodeWindowMs() + 1;
    const res = await resolveSessionSend(r, past);
    expect(res.outcome).not.toBe('delivered');
  });

  it('is unknown, not gone, when the episode lapsed but the runner is heartbeating', async () => {
    selectQueue.push([{ deviceId: 'dev-1' }], [{ lastSeenAt: new Date(NOW + 100) }]);
    const res = await resolveSessionSend(row(), NOW + sendEpisodeWindowMs() + 1);
    expect(res.outcome).toBe('unknown');
  });

  it('is gone when the owning runner stopped heartbeating', async () => {
    selectQueue.push([{ deviceId: 'dev-1' }], [{ lastSeenAt: new Date(NOW - 600_000) }]);
    const res = await resolveSessionSend(row(), NOW + sendEpisodeWindowMs() + 1);
    expect(res.outcome).toBe('gone');
  });

  it('is gone when the session has no device to reach', async () => {
    selectQueue.push([{ deviceId: null }]);
    const res = await resolveSessionSend(row(), NOW + sendEpisodeWindowMs() + 1);
    expect(res.outcome).toBe('gone');
  });

  it('reports applied independently of the send outcome', async () => {
    const r = row({
      sendConfirmedAt: new Date(NOW + 100),
      sendOutcome: 'gone',
      appliedAt: new Date(NOW + 5_000),
      appliedTurn: 2,
    });
    await expect(resolveSessionSend(r, NOW + 200)).resolves.toEqual({
      outcome: 'gone',
      applied: true,
    });
  });
});
