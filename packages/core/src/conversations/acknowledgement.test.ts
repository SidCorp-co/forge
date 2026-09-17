/**
 * ISS-1088 — when a request is marked received and shown as being worked on,
 * measured against receipt and admission as separate instants.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerWarn = vi.fn();
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: (...a: unknown[]) => loggerWarn(...a),
    error: vi.fn(),
  },
}));

const { acknowledgeRequest, RECEIVED_FLOOR_MS, WORKING_RENEW_MS } = await import(
  './acknowledgement.js'
);

const VENUE = {
  adapter: 'rocketchat' as const,
  externalId: 'chat.example.co ROOM1',
  shape: 'group' as const,
  projectId: 'p1',
};

const acks: unknown[] = [];
const acknowledge = vi.fn(async (_venue: unknown, ack: unknown) => {
  acks.push(ack);
});
const transport = { acknowledge };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-18T10:00:10.000Z'));
  acks.length = 0;
  acknowledge.mockClear();
  loggerWarn.mockClear();
});
afterEach(() => vi.useRealTimers());

const start = (receivedAgoMs: number, messageId: string | null = 'rc-1') =>
  acknowledgeRequest({
    transport,
    venue: VENUE,
    anchor: { messageId, receivedAt: new Date(Date.now() - receivedAgoMs) },
  });

describe('working', () => {
  it('is shown at admission and renewed every 5 seconds while the turn runs (criterion 6)', async () => {
    const ack = start(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(acks).toEqual([{ kind: 'working', on: true }]);
    await vi.advanceTimersByTimeAsync(WORKING_RENEW_MS);
    expect(acks.filter((a) => (a as { kind: string }).kind === 'working')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(WORKING_RENEW_MS);
    expect(acks.filter((a) => (a as { kind: string }).kind === 'working')).toHaveLength(3);
    await ack.settle();
    expect(acks.slice(-2)).toEqual([
      { kind: 'working', on: false },
      { kind: 'received', messageId: 'rc-1', on: false },
    ]);
  });

  it('renews under the client’s 15-second expiry, so a dead core leaves no indicator past it (criterion 6)', () => {
    expect(WORKING_RENEW_MS).toBeLessThan(15_000);
    expect(RECEIVED_FLOOR_MS).toBe(5000);
  });
});

describe('received, against receipt and admission separately (criteria 3, 4, 31)', () => {
  it('admitted at receipt+4s: set at receipt+5s, one second after admission', async () => {
    start(4000);
    await vi.advanceTimersByTimeAsync(999);
    expect(acks.some((a) => (a as { kind: string }).kind === 'received')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(acks).toContainEqual({ kind: 'received', messageId: 'rc-1', on: true });
  });

  it('admitted at receipt+7s: set at admission', async () => {
    start(7000);
    await vi.advanceTimersByTimeAsync(0);
    expect(acks).toEqual([
      { kind: 'working', on: true },
      { kind: 'received', messageId: 'rc-1', on: true },
    ]);
  });

  it('a turn that settles within the floor never sets it, and clears only working (criterion 4)', async () => {
    const ack = start(0);
    await vi.advanceTimersByTimeAsync(3000);
    await ack.settle();
    expect(acks).toEqual([
      { kind: 'working', on: true },
      { kind: 'working', on: false },
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(acks).toHaveLength(2);
  });

  it('settle clears both once received was set, working first (criteria 7, 10)', async () => {
    const ack = start(6000);
    await vi.advanceTimersByTimeAsync(0);
    await ack.settle();
    expect(acks.slice(-2)).toEqual([
      { kind: 'working', on: false },
      { kind: 'received', messageId: 'rc-1', on: false },
    ]);
  });

  it('marks nothing received on a message the transport gave no id, and still shows working', async () => {
    const ack = start(9000, null);
    await vi.advanceTimersByTimeAsync(0);
    await ack.settle();
    expect(acks.every((a) => (a as { kind: string }).kind === 'working')).toBe(true);
  });
});

describe('a transport without acknowledge, and one that refuses', () => {
  it('is a no-op for a transport that declares no acknowledge (criterion 1)', async () => {
    const ack = acknowledgeRequest({
      transport: {},
      venue: VENUE,
      anchor: { messageId: 'rc-1', receivedAt: new Date(Date.now() - 9000) },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await ack.settle();
    expect(acks).toEqual([]);
  });

  it('logs a refusal and never throws, and keeps going', async () => {
    acknowledge.mockRejectedValueOnce(new Error('403'));
    const ack = start(9000);
    await vi.advanceTimersByTimeAsync(0);
    await ack.settle();
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(acks).toContainEqual({ kind: 'received', messageId: 'rc-1', on: true });
  });

  it('settles idempotently', async () => {
    const ack = start(9000);
    await ack.settle();
    await ack.settle();
    expect(acks.filter((a) => (a as { on: boolean }).on === false)).toHaveLength(2);
  });
});
