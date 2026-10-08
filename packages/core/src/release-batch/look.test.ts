// An agent's look at a release batch (ISS-1282): what is refused before Forge reads anything, what
// is read when it is not, and what the answer says about closing on it.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../knowledge/service.js', () => ({ getKnowledgeEntry: async () => null }));

const readRun = vi.fn();
vi.mock('./finish-precondition.js', () => ({ readReleaseRun: (id: string) => readRun(id) }));

vi.mock('./abort-stamp.js', async (importActual) => {
  const { ReleaseBatchAbortedError } = await import('./errors.js');
  return {
    ...(await importActual<typeof import('./abort-stamp.js')>()),
    abortedError: async () => new ReleaseBatchAbortedError('released', 'p-1'),
  };
});

const channelsMock = vi.fn();
vi.mock('./channel.js', async (importActual) => ({
  ...(await importActual<typeof import('./channel.js')>()),
  resolveReleaseChannels: (id: string) => channelsMock(id),
}));

const takeReading = vi.fn();
const judgeRecorded = vi.fn();
vi.mock('./readings.js', async (importActual) => ({
  ...(await importActual<typeof import('./readings.js')>()),
  takeReading: (a: unknown) => takeReading(a),
  judgeRecordedReadings: (a: unknown) => judgeRecorded(a),
}));

const { lookAtBatch } = await import('./look.js');
const errors = await import('./errors.js');

const RUN = '44444444-4444-4444-8444-444444444444';
const NEW = 'b853f813d0e4b2a1c9f8e7d6c5b4a39281706f5e';

const probed = (over: Record<string, unknown> = {}) => ({
  bindingId: 'b-1',
  provider: 'coolify',
  label: '',
  instructions: null,
  releaseRunnerLabel: null,
  verify: { probes: [{ url: 'https://api.example.test/version' }] },
  verifySource: 'binding',
  rollback: null,
  ...over,
});

const stored = {
  id: 'reading-1',
  runId: RUN,
  takenAt: new Date('2026-10-08T10:00:00.000Z'),
  takenBy: 'u-1',
  unread: [],
  bindings: [
    {
      bindingId: 'b-1',
      name: 'coolify b-1',
      state: {
        health: 'up',
        identity: NEW,
        answeredBy: [],
        readings: ['https://api.example.test/version -> x'],
        unhealthy: [],
        unidentified: [],
        disagreement: null,
      },
    },
  ],
};

const look = (commit?: string) => lookAtBatch({ runId: RUN, takenBy: 'u-1', commit });

beforeEach(() => {
  vi.clearAllMocks();
  readRun.mockResolvedValue({
    projectId: 'p-1',
    status: 'running',
    metadata: {},
    releaseVersion: '0.1.0',
  });
  channelsMock.mockResolvedValue([probed()]);
  takeReading.mockResolvedValue(stored);
  judgeRecorded.mockResolvedValue({
    ok: true,
    moved: true,
    identity: NEW,
    evidence: ['reading-1'],
  });
});

describe('what a look refuses before it reads anything', () => {
  it('refuses a commit that is not a whole sha, naming the rule and reading nothing', async () => {
    await expect(look('b853f81')).rejects.toThrow(errors.ReleaseNotVerifiedError);

    expect(takeReading).not.toHaveBeenCalled();
    expect(readRun).not.toHaveBeenCalled();
  });

  it('refuses a batch that was aborted, in the account the finish gives', async () => {
    readRun.mockResolvedValue({ projectId: 'p-1', status: 'cancelled', metadata: {} });

    await expect(look()).rejects.toThrow(errors.ReleaseBatchAbortedError);
    expect(takeReading).not.toHaveBeenCalled();
  });

  it('refuses a batch an abort has begun on, though its run has not yet gone cancelled', async () => {
    readRun.mockResolvedValue({
      projectId: 'p-1',
      status: 'running',
      metadata: { abort: { id: 'a-1', at: 'x', reason: 'y', by: 'u', roster: 'returning' } },
    });

    await expect(look()).rejects.toThrow(errors.ReleaseBatchAbortedError);
    expect(takeReading).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed', 'cancelled_by_nobody'])(
    'refuses a batch whose run is %s, naming the status',
    async (status) => {
      readRun.mockResolvedValue({ projectId: 'p-1', status, metadata: {} });

      await expect(look()).rejects.toThrow(errors.ReleaseRunClosedError);
      await expect(look()).rejects.toThrow(`This batch's run is ${status}`);
      expect(takeReading).not.toHaveBeenCalled();
    },
  );

  it('takes a look on a paused run, which still holds its roster', async () => {
    readRun.mockResolvedValue({ projectId: 'p-1', status: 'paused', metadata: {} });

    await expect(look()).resolves.toMatchObject({ reading: { id: 'reading-1' } });
  });

  it('refuses where no live binding declares a probe, rather than reading nothing and calling it a look', async () => {
    channelsMock.mockResolvedValue([probed({ verify: null, verifySource: 'none' })]);

    await expect(look()).rejects.toThrow(errors.ReleaseNothingToReadError);
    expect(takeReading).not.toHaveBeenCalled();
  });

  it('refuses where a binding’s declaration was refused, naming the binding', async () => {
    channelsMock.mockResolvedValue([probed({ verify: null, verifySource: 'declared-unusable' })]);

    await expect(look()).rejects.toThrow(errors.ReleaseProbesUnreadableError);
    await expect(look()).rejects.toThrow(/coolify b-1/);
    expect(takeReading).not.toHaveBeenCalled();
  });

  it('refuses a probe url no request can be made to, naming it', async () => {
    channelsMock.mockResolvedValue([probed({ verify: { probes: [{ url: 'api/version' }] } })]);

    await expect(look()).rejects.toThrow(/api\/version/);
    expect(takeReading).not.toHaveBeenCalled();
  });
});

describe('what a look answers', () => {
  it('stores the reading, then judges every reading so far against the commit named', async () => {
    const out = await look(NEW);

    expect(takeReading).toHaveBeenCalledOnce();
    expect(takeReading.mock.calls[0]?.[0]).toMatchObject({ runId: RUN, takenBy: 'u-1' });
    expect(judgeRecorded.mock.calls[0]?.[0]).toMatchObject({ runId: RUN, claim: NEW });
    expect(out.reading).toMatchObject({
      id: 'reading-1',
      takenAt: '2026-10-08T10:00:00.000Z',
      takenBy: 'u-1',
      unread: [],
      bindings: [{ bindingId: 'b-1', name: 'coolify b-1', identity: NEW, health: 'up' }],
    });
    expect(out.judgement).toEqual({ closable: true, moved: true, evidence: ['reading-1'] });
  });

  it('judges a look naming no commit by whether the build moved', async () => {
    await look();

    expect(judgeRecorded.mock.calls[0]?.[0]).toMatchObject({ claim: null });
  });

  it('says why a finish would not close yet, and what is live', async () => {
    judgeRecorded.mockResolvedValue({
      ok: false,
      live: 'abc1234',
      reason: 'the live build is unchanged',
    });

    const out = await look(NEW);

    expect(out.judgement).toEqual({
      closable: false,
      reason: 'the live build is unchanged',
      live: 'abc1234',
    });
    expect(out.reading.id).toBe('reading-1');
  });

  it('names the bindings the reading did not read', async () => {
    takeReading.mockResolvedValue({ ...stored, unread: ['coolify [eu] b-2'] });

    expect((await look()).reading.unread).toEqual(['coolify [eu] b-2']);
  });
});
