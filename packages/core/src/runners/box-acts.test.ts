// What an act asked of a box does when the box's socket drops around the ask: a short drop before the
// frame is taken is waited out inside the answer timeout, never refused at once.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerBoxAct, runOpsRead } from './box-acts.js';

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

const read = { deviceId: 'dev-1', projectId: P, name: 'status', argv: ['forge-ops', 'status', '{}'] };
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
});
