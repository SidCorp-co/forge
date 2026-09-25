// ISS-1190: an abort was noticed only when the verify window closed, so a finish record read
// `verifying` beside a cancelled run for up to the whole window.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTHING_TO_COMPARE, verifyDeployed } from './verify.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const OLD = 'a12b34c5d6e7f8091a2b3c4d5e6f708192a3b4c5';
const NEW = 'b853f813d0e4b2a1c9f8e7d6c5b4a39281706f5e';
const CFG = {
  probes: [{ url: 'https://example.test/api/health', commitPath: 'commit' }],
  timeoutSeconds: 60,
  stableReads: 1,
};

describe('verifyDeployed — the checkpoint', () => {
  it('ends at the checkpoint that throws, before the next reading and without waiting out the window', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ version: '1.2', commit: OLD }),
    });
    const stop = new Error('stopped by the caller');
    let calls = 0;
    const checkpoint = vi.fn(async () => {
      calls += 1;
      if (calls === 3) throw stop;
    });
    let t = 0;

    const out = verifyDeployed({
      cfg: CFG,
      commitBefore: OLD,
      expected: NEW,
      checkpoint,
      // Advancing, so a verification that ignored the checkpoint ends red on its own deadline.
      now: () => (t += 600),
      sleep: async () => undefined,
    });

    await expect(out).rejects.toBe(stop);
    expect(checkpoint).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('verifyDeployed — a claimless window with nothing recorded before', () => {
  it('ends red at its first reading, whatever the live build reports', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ version: '1.2', commit: NEW }),
    });
    let t = 0;

    const out = await verifyDeployed({
      cfg: CFG,
      commitBefore: null,
      expected: null,
      now: () => (t += 600),
      sleep: async () => undefined,
    });

    expect(out).toMatchObject({ ok: false, reason: NOTHING_TO_COMPARE, identity: NEW });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
