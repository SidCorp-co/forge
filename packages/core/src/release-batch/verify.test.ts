// The failure this exists to catch is not "the site is down". It is "the site
// is up, the deploy reported success, and it is serving the previous build".
// Every case below is a version of that.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseVerifyConfig, readLiveCommit, verifyDeployed } from './verify.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function answers(...commits: Array<string | null>) {
  for (const commit of commits) {
    fetchMock.mockResolvedValueOnce(
      commit === null
        ? { ok: false, text: async () => '' }
        : { ok: true, text: async () => JSON.stringify({ version: '1.2', commit }) },
    );
  }
}

const CFG = {
  probes: [{ url: 'https://example.test/api/health', commitPath: 'commit' }],
  timeoutSeconds: 60,
  stableReads: 1,
};

const nowFake = () => 0;
const noSleep = async () => undefined;

describe('parseVerifyConfig', () => {
  it('reads nothing out of a project that declared nothing', () => {
    expect(parseVerifyConfig(undefined)).toBeNull();
    expect(parseVerifyConfig({})).toBeNull();
    expect(parseVerifyConfig({ probes: [] })).toBeNull();
    expect(parseVerifyConfig({ probes: [{ commitPath: 'commit' }] })).toBeNull();
  });

  it('defaults the poll budget rather than polling forever', () => {
    const cfg = parseVerifyConfig({ probes: [{ url: 'https://x.test/h' }] });
    expect(cfg?.timeoutSeconds).toBe(300);
    expect(cfg?.stableReads).toBe(2);
  });
});

describe('readLiveCommit', () => {
  // cm:guard a fleet half on the new build is NOT deployed — returning the first probe's answer would report green while some servers still serve the old one
  it('refuses to answer when two probes disagree', async () => {
    answers('aaa', 'bbb');

    const live = await readLiveCommit({
      probes: [
        { url: 'https://a.test/h', commitPath: 'commit' },
        { url: 'https://b.test/h', commitPath: 'commit' },
      ],
    });

    expect(live).toBeNull();
  });

  it('busts the cache on every read', async () => {
    answers('aaa');

    await readLiveCommit(CFG);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('_forge_cb=');
    expect(fetchMock.mock.calls[0]?.[1]?.headers?.['Cache-Control']).toBe('no-cache');
  });
});

describe('verifyDeployed', () => {
  it('goes green when the live build changed and matches what the release pushed', async () => {
    answers('new-sha');

    const out = await verifyDeployed({
      cfg: CFG,
      commitBefore: 'old-sha',
      expected: 'new-sha',
      now: nowFake,
      sleep: noSleep,
    });

    expect(out).toEqual({ ok: true, commit: 'new-sha' });
  });

  // cm:guard THE case: a 200 from a healthy site proves nothing, and this is the read that separates "deployed" from "still running yesterday's build"
  it('goes red when the site is healthy and still serving the pre-release build', async () => {
    answers('old-sha', 'old-sha', 'old-sha', 'old-sha');

    const out = await verifyDeployed({
      cfg: { ...CFG, timeoutSeconds: 1 },
      commitBefore: 'old-sha',
      expected: 'new-sha',
      now: (() => {
        let t = 0;
        return () => (t += 600);
      })(),
      sleep: noSleep,
    });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toContain('unchanged');
  });

  // cm:guard without the pre-release baseline an agent reporting the commit that was ALREADY live verifies perfectly, which is the exact shape of a release that deployed nothing
  it('goes red when the release reports the commit that was already serving', async () => {
    answers('same-sha', 'same-sha');

    const out = await verifyDeployed({
      cfg: { ...CFG, timeoutSeconds: 1 },
      commitBefore: 'same-sha',
      expected: 'same-sha',
      now: (() => {
        let t = 0;
        return () => (t += 600);
      })(),
      sleep: noSleep,
    });

    expect(out.ok).toBe(false);
  });

  it('goes red when the live build is not the one the release pushed', async () => {
    answers('someone-elses-sha', 'someone-elses-sha');

    const out = await verifyDeployed({
      cfg: { ...CFG, timeoutSeconds: 1 },
      commitBefore: 'old-sha',
      expected: 'new-sha',
      now: (() => {
        let t = 0;
        return () => (t += 600);
      })(),
      sleep: noSleep,
    });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toContain('new-sha');
  });

  it('accepts a release that reports no commit, as long as the build actually moved', async () => {
    answers('new-sha');

    const out = await verifyDeployed({
      cfg: CFG,
      commitBefore: 'old-sha',
      expected: null,
      now: nowFake,
      sleep: noSleep,
    });

    expect(out.ok).toBe(true);
  });

  it('goes red when nothing answers at all', async () => {
    answers(null, null);

    const out = await verifyDeployed({
      cfg: { ...CFG, timeoutSeconds: 1 },
      commitBefore: 'old-sha',
      expected: 'new-sha',
      now: (() => {
        let t = 0;
        return () => (t += 600);
      })(),
      sleep: noSleep,
    });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toContain('no probe answered');
  });

  it('requires the reads to hold still before believing them', async () => {
    answers('new-sha', 'flapping', 'new-sha', 'new-sha');

    const out = await verifyDeployed({
      cfg: { ...CFG, stableReads: 2, timeoutSeconds: 100 },
      commitBefore: 'old-sha',
      expected: null,
      now: nowFake,
      sleep: noSleep,
    });

    expect(out).toEqual({ ok: true, commit: 'new-sha' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
