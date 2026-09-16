/**
 * ISS-1056 — the registration: the queue exists before the schedule names it, the worker is the
 * tick, the cron is daily so a failed week is tried again under the same window, and the guard
 * makes a second registration a no-op.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const callOrder: string[] = [];
const bossMock = {
  createQueue: vi.fn(async (q: string) => {
    callOrder.push(`createQueue:${q}`);
  }),
  work: vi.fn(async (q: string, _opts: unknown, _handler: () => Promise<void>) => {
    callOrder.push(`work:${q}`);
  }),
  schedule: vi.fn(async (q: string, cron: string) => {
    callOrder.push(`schedule:${q}:${cron}`);
  }),
  unschedule: vi.fn(async (q: string) => {
    callOrder.push(`unschedule:${q}`);
  }),
};
vi.mock('../../queue/boss.js', () => ({ boss: bossMock }));
vi.mock('../../db/client.js', () => ({ db: {} }));
const runOnce = vi.fn(async () => [{ outcome: 'posted', windowId: 'w' }]);
vi.mock('./run.js', () => ({ runAssistantWeeklyOnce: runOnce }));

const {
  ASSISTANT_WEEKLY_CRON,
  ASSISTANT_WEEKLY_QUEUE,
  registerAssistantWeekly,
  resetAssistantWeeklyForTest,
  unregisterAssistantWeekly,
} = await import('./register.js');

beforeEach(() => {
  callOrder.length = 0;
  resetAssistantWeeklyForTest();
  runOnce.mockClear();
});

describe('registerAssistantWeekly', () => {
  it('creates the queue, then the worker, then the daily 04:00 UTC schedule, once', async () => {
    await registerAssistantWeekly();
    await registerAssistantWeekly();
    expect(callOrder).toEqual([
      `createQueue:${ASSISTANT_WEEKLY_QUEUE}`,
      `work:${ASSISTANT_WEEKLY_QUEUE}`,
      `schedule:${ASSISTANT_WEEKLY_QUEUE}:${ASSISTANT_WEEKLY_CRON}`,
    ]);
    expect(ASSISTANT_WEEKLY_CRON).toBe('0 4 * * *');
  });

  it('the cron fires every day of the week, so a failed Monday has a Tuesday under the same window', () => {
    const [, hour, dom, month, dow] = ASSISTANT_WEEKLY_CRON.split(' ');
    expect({ hour, dom, month, dow }).toEqual({ hour: '4', dom: '*', month: '*', dow: '*' });
  });

  it('the worker runs the tick', async () => {
    await registerAssistantWeekly();
    const handler = bossMock.work.mock.calls[0]?.[2];
    expect(handler).toBeTypeOf('function');
    await handler?.();
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it('unregister removes the schedule and lets a later register run again', async () => {
    await registerAssistantWeekly();
    await unregisterAssistantWeekly();
    await unregisterAssistantWeekly();
    expect(callOrder.filter((c) => c.startsWith('unschedule'))).toEqual([
      `unschedule:${ASSISTANT_WEEKLY_QUEUE}`,
    ]);
    await registerAssistantWeekly();
    expect(callOrder.filter((c) => c.startsWith('schedule'))).toHaveLength(2);
  });
});
