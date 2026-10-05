import { describe, expect, it, vi } from 'vitest';
import {
  answerCheckoutHead,
  type CheckoutHeadDeps,
  type CheckoutHeadRead,
  readCheckoutHead,
} from './checkout-head.js';

const SHA = 'a'.repeat(40);
const P = '00000000-0000-4000-8000-000000000001';

function deps(over: Partial<CheckoutHeadDeps> = {}): CheckoutHeadDeps & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    boundCheckouts: async () => [{ deviceId: 'dev-1', runnerId: 'r-1', repoPath: '/w/epod' }],
    listening: () => true,
    send: (_deviceId, envelope) => {
      sent.push(envelope);
      return 1;
    },
    timeoutMs: 200,
    ...over,
  };
}

function refused(read: CheckoutHeadRead) {
  if (read.ok) throw new Error(`expected a refusal, read ${read.head.sha}`);
  return read;
}

function requestIdOf(sent: unknown[]): string {
  const frame = sent[0] as { event: string; data: { requestId: string } };
  expect(frame.event).toBe('checkout.head.read');
  return frame.data.requestId;
}

describe('readCheckoutHead: the default-branch head a bound runner checkout reads', () => {
  it('asks the bound box and takes its answer as evidence, with readAt and via', async () => {
    const d = deps();
    const reading = readCheckoutHead(P, 'dev', d);
    await vi.waitFor(() => expect(d.sent).toHaveLength(1));
    const accepted = answerCheckoutHead('dev-1', requestIdOf(d.sent), {
      projectId: P,
      sha: SHA,
      ref: 'refs/heads/dev',
      readAt: '2026-10-05T10:00:01.000Z',
      via: 'runner-checkout',
      origin: '/srv/git/epod.git',
    });
    expect(accepted).toEqual({ ok: true });
    await expect(reading).resolves.toEqual({
      ok: true,
      head: {
        sha: SHA,
        ref: 'refs/heads/dev',
        readAt: '2026-10-05T10:00:01.000Z',
        via: 'runner-checkout',
        deviceId: 'dev-1',
      },
    });
  });

  it('refuses by name when no runner holds a bound checkout, naming both ways out', async () => {
    const err = refused(await readCheckoutHead(P, 'dev', deps({ boundCheckouts: async () => [] })));
    expect(err.ok).toBe(false);
    expect(err.reason).toBe('no_checkout');
    expect(err.detail).toContain('Integrations');
    expect(err.detail).toContain('forge-runner bind');
  });

  it('refuses by name when every bound box is offline, sending nothing', async () => {
    const d = deps({ listening: () => false });
    const err = refused(await readCheckoutHead(P, 'dev', d));
    expect(err.reason).toBe('no_runner_online');
    expect(err.detail).toContain('forge-runner bind');
    expect(d.sent).toHaveLength(0);
  });

  it('never takes an answer from a box it did not ask, and says it waited unanswered', async () => {
    const d = deps();
    const reading = readCheckoutHead(P, 'dev', d);
    await vi.waitFor(() => expect(d.sent).toHaveLength(1));
    const id = requestIdOf(d.sent);
    expect(
      answerCheckoutHead('dev-2', id, { projectId: P, sha: SHA, ref: 'refs/heads/dev' }),
    ).toEqual({ ok: false, code: 'CHECKOUT_HEAD_NOT_ASKED' });
    const err = refused(await reading);
    expect(err.reason).toBe('unanswered');
    expect(answerCheckoutHead('dev-1', id, { projectId: P, sha: SHA })).toEqual({
      ok: false,
      code: 'CHECKOUT_HEAD_NOT_ASKED',
    });
  });

  it("carries the box's own refusal, and refuses an answer that names no commit", async () => {
    const d = deps();
    const failed = readCheckoutHead(P, 'dev', d);
    await vi.waitFor(() => expect(d.sent).toHaveLength(1));
    answerCheckoutHead('dev-1', requestIdOf(d.sent), {
      projectId: P,
      error: 'branch dev is absent at origin /srv/git/epod.git',
    });
    const err = refused(await failed);
    expect(err.reason).toBe('runner_refused');
    expect(err.detail).toContain('branch dev is absent at origin');

    const d2 = deps();
    const junk = readCheckoutHead(P, 'dev', d2);
    await vi.waitFor(() => expect(d2.sent).toHaveLength(1));
    answerCheckoutHead('dev-1', requestIdOf(d2.sent), { projectId: P, sha: 'HEAD' });
    expect(refused(await junk).reason).toBe('runner_refused');
  });
});
