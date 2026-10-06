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
    const reading = readCheckoutHead(P, 'dev', '/srv/git/epod.git', d);
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
    const err = refused(
      await readCheckoutHead(
        P,
        'dev',
        '/srv/git/epod.git',
        deps({ boundCheckouts: async () => [] }),
      ),
    );
    expect(err.ok).toBe(false);
    expect(err.reason).toBe('no_checkout');
    expect(err.detail).toContain('Integrations');
    expect(err.detail).toContain('forge-runner bind');
  });

  it('refuses by name when every bound box is offline, sending nothing', async () => {
    const d = deps({ listening: () => false });
    const err = refused(await readCheckoutHead(P, 'dev', '/srv/git/epod.git', d));
    expect(err.reason).toBe('no_runner_online');
    expect(err.detail).toContain('forge-runner bind');
    expect(d.sent).toHaveLength(0);
  });

  it('never takes an answer from a box it did not ask, and says it waited unanswered', async () => {
    const d = deps();
    const reading = readCheckoutHead(P, 'dev', '/srv/git/epod.git', d);
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
    const failed = readCheckoutHead(P, 'dev', '/srv/git/epod.git', d);
    await vi.waitFor(() => expect(d.sent).toHaveLength(1));
    answerCheckoutHead('dev-1', requestIdOf(d.sent), {
      projectId: P,
      error: 'branch dev is absent at origin /srv/git/epod.git',
    });
    const err = refused(await failed);
    expect(err.reason).toBe('runner_refused');
    expect(err.detail).toContain('branch dev is absent at origin');

    const d2 = deps();
    const junk = readCheckoutHead(P, 'dev', '/srv/git/epod.git', d2);
    await vi.waitFor(() => expect(d2.sent).toHaveLength(1));
    answerCheckoutHead('dev-1', requestIdOf(d2.sent), { projectId: P, sha: 'HEAD' });
    expect(refused(await junk).reason).toBe('runner_refused');
  });
});

const REPO = 'github.com/org/app';
const read = (d: CheckoutHeadDeps, repository = REPO) => readCheckoutHead(P, 'dev', repository, d);

function framesTo(sent: unknown[]) {
  return (sent as { data: { requestId: string; runnerId: string; repoPath: string } }[]).map(
    (f) => f.data,
  );
}

const good = (origin: string) => ({
  projectId: P,
  sha: SHA,
  ref: 'refs/heads/dev',
  readAt: '2026-10-05T10:00:01.000Z',
  via: 'runner-checkout',
  origin,
});

describe("readCheckoutHead takes a head only from the project's declared repository (R1-03)", () => {
  it('refuses an answer whose origin is another repository, naming both', async () => {
    const d = deps();
    const reading = read(d);
    await vi.waitFor(() => expect(d.sent).toHaveLength(1));
    const outcome = answerCheckoutHead(
      'dev-1',
      requestIdOf(d.sent),
      good('https://github.com/someone/app.git'),
    );
    expect(outcome).toMatchObject({ ok: false, code: 'CHECKOUT_HEAD_OTHER_REPOSITORY' });
    const err = refused(await reading);
    expect(err.reason).toBe('other_repository');
    expect(err.detail).toContain('https://github.com/someone/app.git');
    expect(err.detail).toContain(REPO);
  });

  it.each([
    ['https://github.com/org/app.git'],
    ['https://token@github.com/Org/App'],
    ['git@github.com:org/app.git'],
    ['ssh://git@github.com:22/org/app.git'],
  ])('takes the declared repository in the spelling %s', async (origin) => {
    const d = deps();
    const reading = read(d);
    await vi.waitFor(() => expect(d.sent).toHaveLength(1));
    expect(answerCheckoutHead('dev-1', requestIdOf(d.sent), good(origin))).toEqual({ ok: true });
    expect((await reading).ok).toBe(true);
  });

  it('compares a local-path repository by its path', async () => {
    const d = deps();
    const same = read(d, '/srv/git/epod.git');
    await vi.waitFor(() => expect(d.sent).toHaveLength(1));
    answerCheckoutHead('dev-1', requestIdOf(d.sent), good('file:///srv/git/epod.git/'));
    expect((await same).ok).toBe(true);

    const d2 = deps();
    const other = read(d2, '/srv/git/epod.git');
    await vi.waitFor(() => expect(d2.sent).toHaveLength(1));
    expect(
      answerCheckoutHead('dev-1', requestIdOf(d2.sent), good('/srv/old/epod.git')),
    ).toMatchObject({ code: 'CHECKOUT_HEAD_OTHER_REPOSITORY' });
    expect(refused(await other).reason).toBe('other_repository');
  });

  it('refuses an answer that names no origin, since nothing shows it is the declared repository', async () => {
    const d = deps();
    const reading = read(d);
    await vi.waitFor(() => expect(d.sent).toHaveLength(1));
    const { origin: _origin, ...bare } = good('x');
    expect(answerCheckoutHead('dev-1', requestIdOf(d.sent), bare)).toMatchObject({
      ok: false,
      code: 'CHECKOUT_HEAD_MALFORMED',
    });
    expect(refused(await reading).reason).toBe('runner_refused');
  });
});

describe('readCheckoutHead asks every connected bound box (R1-04)', () => {
  const two = {
    boundCheckouts: async () => [
      { deviceId: 'dev-1', runnerId: 'r-1', repoPath: '/w/old' },
      { deviceId: 'dev-2', runnerId: 'r-2', repoPath: '/w/epod' },
    ],
  };

  it('names the binding it asks for, and takes the second box when the first refuses', async () => {
    const d = deps(two);
    const reading = read(d);
    await vi.waitFor(() => expect(d.sent).toHaveLength(2));
    const [first, second] = framesTo(d.sent);
    expect(first).toMatchObject({ runnerId: 'r-1', repoPath: '/w/old' });
    expect(second).toMatchObject({ runnerId: 'r-2', repoPath: '/w/epod' });
    answerCheckoutHead('dev-1', first?.requestId ?? '', {
      projectId: P,
      error: 'the bound checkout /w/old does not exist',
    });
    expect(answerCheckoutHead('dev-2', second?.requestId ?? '', good(REPO))).toEqual({ ok: true });
    const got = await reading;
    expect(got.ok && got.head.deviceId).toBe('dev-2');
  });

  it("when no box answers well, names each box's refusal", async () => {
    const d = deps(two);
    const reading = read(d);
    await vi.waitFor(() => expect(d.sent).toHaveLength(2));
    const [first, second] = framesTo(d.sent);
    answerCheckoutHead('dev-1', first?.requestId ?? '', {
      projectId: P,
      error: 'the bound checkout /w/old does not exist',
    });
    answerCheckoutHead('dev-2', second?.requestId ?? '', good('gitlab.com/fork/app'));
    const err = refused(await reading);
    expect(err.reason).toBe('every_box_failed');
    expect(err.detail).toContain('/w/old does not exist');
    expect(err.detail).toContain('gitlab.com/fork/app');
    expect(err.detail).toContain('runner_refused');
    expect(err.detail).toContain('other_repository');
  });

  it('skips a box that is not connected and asks the one that is', async () => {
    const d = deps({ ...two, listening: (id) => id === 'dev-2' });
    const reading = read(d);
    await vi.waitFor(() => expect(d.sent).toHaveLength(1));
    const [only] = framesTo(d.sent);
    expect(only?.runnerId).toBe('r-2');
    answerCheckoutHead('dev-2', only?.requestId ?? '', good(REPO));
    expect((await reading).ok).toBe(true);
  });
});
