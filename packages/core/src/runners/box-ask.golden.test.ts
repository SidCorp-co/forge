// Pins what both box reads (`checkout.head.read`, `checkout.ancestry.read`) do on the three edges
// their own suites leave open: the box dropping before the frame is taken, an answer for another
// project, and an answer replayed after it settled the read.

import { describe, expect, it, vi } from 'vitest';
import { answerCheckoutAncestry, readCheckoutAncestry } from './checkout-ancestry.js';
import { answerCheckoutHead, readCheckoutHead } from './checkout-head.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const P = '00000000-0000-4000-8000-000000000001';
const Q = '00000000-0000-4000-8000-000000000002';
const box = { deviceId: 'dev-1', runnerId: 'r-1', repoPath: '/w/epod' };

function wire(took = 1) {
  const sent: { event: string; data: { requestId: string } }[] = [];
  return {
    sent,
    boundCheckouts: async () => [box],
    listening: () => true,
    send: (_d: string, envelope: unknown) => {
      sent.push(envelope as (typeof sent)[number]);
      return took;
    },
    timeoutMs: 5_000,
    now: () => 0,
  };
}

describe('a box that drops before the frame is taken', () => {
  it('head: settles no_runner_online naming the box and the ref', async () => {
    const read = await readCheckoutHead(P, 'dev', '/srv/git/epod.git', wire(0));
    expect(read).toMatchObject({ ok: false, reason: 'no_runner_online' });
    expect(read.ok ? '' : read.detail).toContain(
      'the box holding /w/epod disconnected before it could be asked for refs/heads/dev',
    );
  });
  it('ancestry: settles no_runner_online naming the box', async () => {
    const read = await readCheckoutAncestry(P, null, [{ commit: SHA, release: OTHER }], wire(0));
    expect(read).toMatchObject({ ok: false, reason: 'no_runner_online' });
    expect(read.ok ? '' : read.detail).toContain(
      'the box holding /w/epod disconnected before it could be asked',
    );
  });
});

describe('an answer for another project, or replayed', () => {
  it('head: another project is not asked; a replay after settling is not asked either', async () => {
    const w = wire();
    const reading = readCheckoutHead(P, 'dev', '/srv/git/epod.git', w);
    await vi.waitFor(() => expect(w.sent).toHaveLength(1));
    const id = w.sent[0]?.data.requestId ?? '';
    expect(answerCheckoutHead('dev-1', id, { projectId: Q, sha: SHA })).toEqual({
      ok: false,
      code: 'CHECKOUT_HEAD_NOT_ASKED',
    });
    const good = {
      projectId: P,
      sha: SHA,
      ref: 'refs/heads/dev',
      readAt: '2026-10-05T10:00:01.000Z',
      via: 'runner-checkout',
      origin: '/srv/git/epod.git',
    };
    expect(answerCheckoutHead('dev-1', id, good)).toEqual({ ok: true });
    expect((await reading).ok).toBe(true);
    expect(answerCheckoutHead('dev-1', id, good)).toEqual({
      ok: false,
      code: 'CHECKOUT_HEAD_NOT_ASKED',
    });
  });
  it('ancestry: another project is not asked; a replay after settling is not asked either', async () => {
    const w = wire();
    const pair = { commit: SHA, release: OTHER };
    const reading = readCheckoutAncestry(P, null, [pair], w);
    await vi.waitFor(() => expect(w.sent).toHaveLength(1));
    const id = w.sent[0]?.data.requestId ?? '';
    expect(answerCheckoutAncestry('dev-1', id, { projectId: Q })).toEqual({
      ok: false,
      code: 'CHECKOUT_ANCESTRY_NOT_ASKED',
    });
    const good = {
      projectId: P,
      via: 'runner-checkout',
      readAt: '2026-10-05T10:00:01.000Z',
      fetched: false,
      origin: '/srv/git/epod.git',
      answers: [{ ...pair, ancestor: true }],
    };
    expect(answerCheckoutAncestry('dev-1', id, good)).toEqual({ ok: true });
    expect((await reading).ok).toBe(true);
    expect(answerCheckoutAncestry('dev-1', id, good)).toEqual({
      ok: false,
      code: 'CHECKOUT_ANCESTRY_NOT_ASKED',
    });
  });
});
