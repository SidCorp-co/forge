// What an act asked of a box does when the box's socket drops around the ask: a short drop before the
// frame is taken is waited out inside the answer timeout, never refused at once.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerBoxAct, runHostCommand, runOpsRead } from './box-acts.js';

const P = '00000000-0000-4000-8000-000000000001';

interface Sent {
  event: string;
  data: { requestId: string };
}

/** A box whose socket takes a frame only while `online`; every frame it took is kept. */
function flapping() {
  const box = { online: false, sent: [] as Sent[] };
  return {
    box,
    deps: {
      send: (_d: string, envelope: { event: string; data: unknown }) => {
        if (!box.online) return 0;
        box.sent.push(envelope as Sent);
        return 1;
      },
    },
  };
}

const read = {
  deviceId: 'dev-1',
  projectId: P,
  name: 'status',
  argv: ['forge-ops', 'status', '{}'],
};
const answer = { projectId: P, exitCode: 0, stdout: 'all up', stderr: '', durationMs: 120 };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('an ops read asked while its box reconnects', () => {
  it('is sent once the box is back and answered, not refused disconnected', async () => {
    const { box, deps } = flapping();
    let settled = false;
    const reading = runOpsRead({ ...read, timeoutMs: 30_000 }, deps).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(settled).toBe(false);
    expect(box.sent).toEqual([]);
    box.online = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(box.sent).toHaveLength(1);
    expect(answerBoxAct('dev-1', box.sent[0]?.data.requestId ?? '', answer)).toBe(true);
    expect(await reading).toMatchObject({ ok: true, value: { name: 'status', stdout: 'all up' } });
  });

  it('still settles disconnected, naming the wait, once the timeout passes with no reconnect', async () => {
    const { box, deps } = flapping();
    const reading = runOpsRead({ ...read, timeoutMs: 5_000 }, deps);
    await vi.advanceTimersByTimeAsync(19_999);
    box.online = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(await reading).toEqual({
      ok: false,
      transport: 'disconnected',
      why: 'the box disconnected before it could be asked (ops.read) and did not reconnect within 20s',
    });
    box.online = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(box.sent).toEqual([]);
  });
});

describe('an act whose frame a socket already took', () => {
  it('is never sent again when the box drops, and settles unanswered at the timeout', async () => {
    const { box, deps } = flapping();
    box.online = true;
    const running = runHostCommand(
      { deviceId: 'dev-1', projectId: P, host: 'web-1', command: 'systemctl restart api' },
      deps,
    );
    expect(box.sent.map((f) => f.event)).toEqual(['host.command']);
    box.online = false;
    await vi.advanceTimersByTimeAsync(10_000);
    box.online = true;
    await vi.advanceTimersByTimeAsync(65_000);
    expect(await running).toMatchObject({ ok: false, transport: 'unanswered' });
    expect(box.sent).toHaveLength(1);
  });

  it('a write asked while the box is down is sent exactly once when it is back', async () => {
    const { box, deps } = flapping();
    const running = runHostCommand(
      { deviceId: 'dev-1', projectId: P, host: 'web-1', command: 'systemctl restart api' },
      deps,
    );
    await vi.advanceTimersByTimeAsync(3_000);
    box.online = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(box.sent).toHaveLength(1);
    const id = box.sent[0]?.data.requestId ?? '';
    expect(answerBoxAct('dev-1', id, { projectId: P, exitCode: 0, stdout: 'done' })).toBe(true);
    expect(await running).toMatchObject({ ok: true, value: { host: 'web-1', stdout: 'done' } });
    expect(answerBoxAct('dev-1', id, { projectId: P, exitCode: 0 })).toBe(false);
  });
});
