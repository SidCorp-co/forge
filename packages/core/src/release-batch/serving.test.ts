import { beforeEach, describe, expect, it, vi } from 'vitest';

const collectReleaseBlockers = vi.fn();
const readLiveState = vi.fn();

vi.mock('./blockers.js', () => ({
  collectReleaseBlockers: (...a: unknown[]) => collectReleaseBlockers(...(a as [])),
}));
vi.mock('./verify.js', () => ({
  readLiveState: (...a: unknown[]) => readLiveState(...(a as [])),
}));

const { readServingDeployment } = await import('./serving.js');

const PROJECT = '11111111-1111-4111-8111-111111111111';
const channel = (verify: unknown) => ({ verify, verifySource: 'binding' });
const state = (over: Record<string, unknown> = {}) => ({
  health: 'up',
  identity: 'abc1234',
  readings: ['https://api/version -> abc1234'],
  unhealthy: [],
  unidentified: [],
  disagreement: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('readServingDeployment', () => {
  it('answers what the probes report, derived at the moment of the call', async () => {
    collectReleaseBlockers.mockResolvedValue({
      projectExists: true,
      channels: [channel({ probes: [{ url: 'https://api/version' }] })],
    });
    readLiveState.mockResolvedValue(state());

    const read = await readServingDeployment(PROJECT);

    expect(read).toMatchObject({ ok: true, deployment: { identity: 'abc1234', health: 'up' } });
    expect(readLiveState).toHaveBeenCalledTimes(1);
  });

  it('reads the probes again on the next call rather than answering from the last one', async () => {
    collectReleaseBlockers.mockResolvedValue({
      projectExists: true,
      channels: [channel({ probes: [{ url: 'https://api/version' }] })],
    });
    readLiveState
      .mockResolvedValueOnce(state())
      .mockResolvedValueOnce(state({ identity: 'def5678' }));

    const first = await readServingDeployment(PROJECT);
    const second = await readServingDeployment(PROJECT);

    expect(first).toMatchObject({ deployment: { identity: 'abc1234' } });
    expect(second).toMatchObject({ deployment: { identity: 'def5678' } });
  });

  it('keeps health and identity apart when the fleet disagrees', async () => {
    collectReleaseBlockers.mockResolvedValue({
      projectExists: true,
      channels: [channel({ probes: [{ url: 'https://a' }, { url: 'https://b' }] })],
    });
    readLiveState.mockResolvedValue(
      state({ identity: null, disagreement: ['abc1234', 'def5678'] }),
    );

    const read = await readServingDeployment(PROJECT);

    expect(read).toMatchObject({
      ok: true,
      deployment: { health: 'up', identity: null, disagreement: ['abc1234', 'def5678'] },
    });
  });

  it('refuses by name when the project declares no probe, without reading anything', async () => {
    collectReleaseBlockers.mockResolvedValue({ projectExists: true, channels: [channel(null)] });

    const read = await readServingDeployment(PROJECT);

    expect(read).toMatchObject({ ok: false, code: 'PROBES_UNDECLARED' });
    expect(readLiveState).not.toHaveBeenCalled();
  });

  it('answers a named refusal, not a throw, when a probe url cannot be parsed', async () => {
    collectReleaseBlockers.mockResolvedValue({
      projectExists: true,
      channels: [channel({ probes: [{ url: 'api/version' }] })],
    });
    readLiveState.mockRejectedValue(new TypeError('Invalid URL'));

    const read = await readServingDeployment(PROJECT);

    expect(read).toMatchObject({ ok: false, code: 'PROBE_URL_INVALID' });
  });

  it('says the project is not there rather than reporting no probes', async () => {
    collectReleaseBlockers.mockResolvedValue({ projectExists: false, channels: null });

    await expect(readServingDeployment(PROJECT)).resolves.toMatchObject({ code: 'NO_PROJECT' });
  });
});
