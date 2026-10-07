import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AncestryRead,
  answerCheckoutAncestry,
  type CheckoutAncestryDeps,
  forgetSilentBoxes,
  readCheckoutAncestry,
} from './checkout-ancestry.js';

const P = '00000000-0000-4000-8000-000000000001';
const REPO = 'github.com/acme/app';
const [C, R] = ['c'.repeat(40), 'e'.repeat(40)];
const PAIRS = [{ commit: C, release: R }];

type Sent = { deviceId: string; event: string; data: { requestId: string; repoPath: string } };

function deps(over: Partial<CheckoutAncestryDeps> = {}): CheckoutAncestryDeps & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    boundCheckouts: async () => [
      { deviceId: 'dev-1', runnerId: 'r-1', repoPath: '/w/app' },
      { deviceId: 'dev-2', runnerId: 'r-2', repoPath: '/w/app-2' },
    ],
    listening: () => true,
    send: (deviceId, envelope) => {
      sent.push({ deviceId, ...(envelope as Omit<Sent, 'deviceId'>) });
      return 1;
    },
    timeoutMs: 100,
    now: () => Date.now(),
    ...over,
  };
}

const good = (ancestor = true) => ({
  projectId: P,
  origin: 'https://github.com/acme/app.git',
  readAt: '2026-10-07T10:00:00Z',
  via: 'runner-checkout',
  fetched: false,
  answers: [{ commit: C, release: R, ancestor }],
});

function refused(read: AncestryRead) {
  if (read.ok) throw new Error('expected a refusal, read an answer');
  return read;
}

beforeEach(() => forgetSilentBoxes());

describe('readCheckoutAncestry: whether a commit is in a release, as a bound box reads it', () => {
  it("asks ONE box, the project's oldest binding, and takes its answer as evidence", async () => {
    const d = deps();
    const reading = readCheckoutAncestry(P, REPO, PAIRS, d);
    await new Promise((r) => setTimeout(r, 0));
    expect(d.sent.map((s) => [s.deviceId, s.event, s.data.repoPath])).toEqual([
      ['dev-1', 'checkout.ancestry.read', '/w/app'],
    ]);
    expect(answerCheckoutAncestry('dev-1', d.sent[0]?.data.requestId ?? '', good())).toEqual({
      ok: true,
    });
    const read = await reading;
    if (!read.ok) throw new Error(read.detail);
    expect(read.reading).toMatchObject({
      via: 'box-read',
      deviceId: 'dev-1',
      repoPath: '/w/app',
      fetched: false,
    });
    expect(read.reading.answers.get(`${C}@${R}`)).toEqual({ ancestor: true });
  });

  it('never asks a box that is not connected, and with none bound says so', async () => {
    const d = deps({ listening: (id) => id === 'dev-2' });
    const reading = readCheckoutAncestry(P, REPO, PAIRS, d);
    await new Promise((r) => setTimeout(r, 0));
    expect(d.sent.map((s) => s.deviceId)).toEqual(['dev-2']);
    answerCheckoutAncestry('dev-2', d.sent[0]?.data.requestId ?? '', good(false));
    expect((await reading).ok).toBe(true);

    const none = deps({ boundCheckouts: async () => [] });
    expect(refused(await readCheckoutAncestry(P, REPO, PAIRS, none)).reason).toBe('no_checkout');
    expect(none.sent).toEqual([]);
  });

  it('refuses an answer from a box it did not ask', async () => {
    const d = deps();
    const reading = readCheckoutAncestry(P, REPO, PAIRS, d);
    await new Promise((r) => setTimeout(r, 0));
    const id = d.sent[0]?.data.requestId ?? '';
    expect(answerCheckoutAncestry('dev-2', id, good())).toEqual({
      ok: false,
      code: 'CHECKOUT_ANCESTRY_NOT_ASKED',
    });
    answerCheckoutAncestry('dev-1', id, good());
    expect((await reading).ok).toBe(true);
  });

  it('refuses an answer that leaves a pair unanswered, naming it, and settles as the box refusing', async () => {
    const d = deps();
    const reading = readCheckoutAncestry(P, REPO, PAIRS, d);
    await new Promise((r) => setTimeout(r, 0));
    const outcome = answerCheckoutAncestry('dev-1', d.sent[0]?.data.requestId ?? '', {
      ...good(),
      answers: [],
    });
    expect(outcome).toMatchObject({ ok: false, code: 'CHECKOUT_ANCESTRY_MALFORMED' });
    const read = refused(await reading);
    expect(read.reason).toBe('runner_refused');
    expect(read.detail).toContain('unanswered');
  });

  it('carries the error a box could not read with, its token removed', async () => {
    const d = deps();
    const reading = readCheckoutAncestry(P, REPO, PAIRS, d);
    await new Promise((r) => setTimeout(r, 0));
    answerCheckoutAncestry('dev-1', d.sent[0]?.data.requestId ?? '', {
      projectId: P,
      error: 'fetch from https://x:ghp_secret@github.com/acme/app.git failed',
    });
    const read = refused(await reading);
    expect(read.reason).toBe('runner_refused');
    expect(read.detail).not.toContain('ghp_secret');
  });

  it("refuses a reading of another repository than the project's declared one", async () => {
    const d = deps();
    const reading = readCheckoutAncestry(P, REPO, PAIRS, d);
    await new Promise((r) => setTimeout(r, 0));
    const outcome = answerCheckoutAncestry('dev-1', d.sent[0]?.data.requestId ?? '', {
      ...good(),
      origin: 'https://github.com/fork/app.git',
    });
    expect(outcome).toMatchObject({ code: 'CHECKOUT_ANCESTRY_OTHER_REPOSITORY' });
    expect(refused(await reading).reason).toBe('other_repository');
  });

  it('names a box that let the read lapse, and does not wait on it again for a while', async () => {
    const d = deps({
      boundCheckouts: async () => [{ deviceId: 'dev-1', runnerId: 'r-1', repoPath: '/w/app' }],
    });
    const first = refused(await readCheckoutAncestry(P, REPO, PAIRS, d));
    expect(first.reason).toBe('unanswered');
    expect(first.detail).toContain('older than this core');

    const again = refused(await readCheckoutAncestry(P, REPO, PAIRS, d));
    expect(again.reason).toBe('unanswered');
    expect(again.detail).toContain('asked again after');
    expect(d.sent).toHaveLength(1);
  });
});
