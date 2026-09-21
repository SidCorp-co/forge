// The failure this exists to catch is not "the site is down". It is "the site
// is up, the deploy reported success, and it is serving the previous build".
// Every case below is a version of that.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commitsAgree,
  parseVerifyConfig,
  readLiveCommit,
  readLiveState,
  verifyDeployed,
  verifyServingNow,
} from './verify.js';

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
        ? { ok: false, status: 503, text: async () => '' }
        : { ok: true, status: 200, text: async () => JSON.stringify({ version: '1.2', commit }) },
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

    expect(out).toEqual({ ok: true, commit: 'new-sha', health: 'up', identity: 'new-sha' });
  });

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
    expect(out.ok === false && out.health).toBe('down');
    expect(out.ok === false && out.reason).toContain('http 503');
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

    expect(out).toEqual({ ok: true, commit: 'new-sha', health: 'up', identity: 'new-sha' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('readLiveState', () => {
  const twoProbes = {
    probes: [
      { url: 'https://a.test/h', commitPath: 'commit' },
      { url: 'https://b.test/h', commitPath: 'commit' },
    ],
  };

  it('reads a non-2xx as the application not answering, naming the status', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'bad gateway' });

    const state = await readLiveState(CFG);

    expect(state.health).toBe('down');
    expect(state.identity).toBeNull();
    expect(state.unhealthy.join()).toContain('http 502');
  });

  it('reads an unreachable host as the application not answering, naming the transport error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED 10.0.0.1:443'));

    const state = await readLiveState(CFG);

    expect(state.health).toBe('down');
    expect(state.unhealthy.join()).toContain('ECONNREFUSED 10.0.0.1:443');
  });

  it('reads a 200 whose commitPath plucks nothing as healthy and unidentified', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ version: '1.2' }),
    });

    const state = await readLiveState(CFG);

    expect(state.health).toBe('up');
    expect(state.identity).toBeNull();
    expect(state.unhealthy).toEqual([]);
    expect(state.unidentified.join()).toContain('held no commit');
  });

  it('reads a 200 with an unparseable body as healthy and unidentified', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '<html>' });

    const state = await readLiveState(CFG);

    expect(state.health).toBe('up');
    expect(state.identity).toBeNull();
    expect(state.unidentified.join()).toContain('not JSON');
  });

  it('separates a disagreeing fleet from a fleet that answered nothing', async () => {
    answers('aaa', 'bbb');

    const state = await readLiveState(twoProbes);

    expect(state.health).toBe('up');
    expect(state.identity).toBeNull();
    expect(state.disagreement).toEqual(['aaa', 'bbb']);
  });

  it('keeps one reading line per probe, in declaration order', async () => {
    answers('aaa', 'bbb');

    const state = await readLiveState(twoProbes);

    expect(state.readings).toEqual(['https://a.test/h -> aaa', 'https://b.test/h -> bbb']);
  });
});

describe('verifyDeployed, health before identity', () => {
  const runOut = (cfg: typeof CFG) =>
    verifyDeployed({
      cfg: { ...cfg, timeoutSeconds: 1 },
      commitBefore: 'old-sha',
      expected: 'new-sha',
      now: (() => {
        let t = 0;
        return () => (t += 600);
      })(),
      sleep: noSleep,
    });

  it('says the application is not answering when health is down', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, text: async () => '' });

    const out = await runOut(CFG);

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.health).toBe('down');
    expect(out.ok === false && out.reason).toContain('the application is not answering');
  });

  it('names the probe declaration, not the deploy, when the site is healthy and unidentified', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ version: '1.2' }),
    });

    const out = await runOut(CFG);

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.health).toBe('up');
    expect(out.ok === false && out.reason).toContain('probe declaration');
    expect(out.ok === false && out.reason).not.toContain('the application is not answering');
  });

  it('carries health and identity as two readable fields on a red', async () => {
    answers('old-sha', 'old-sha', 'old-sha', 'old-sha');

    const out = await runOut(CFG);

    expect(out.ok === false && out.health).toBe('up');
    expect(out.ok === false && out.identity).toBe('old-sha');
    expect(out.ok === false && out.readings.length).toBe(1);
  });
});

// `commitsAgree` and `verifyServingNow` answer a different question from
// `verifyDeployed`: not "did the deploy I just started arrive" but "is the
// application serving this commit right now". One read, no poll, and a
// comparison that tolerates the abbreviation production reports without
// tolerating a value that is not a commit at all.
describe('commitsAgree', () => {
  it.each([
    ['b853f813d0e4b2a1c9f8e7d6c5b4a39281706f5e', 'b853f813d0e4b2a1c9f8e7d6c5b4a39281706f5e', true],
    ['b853f813d0e4b2a1c9f8e7d6c5b4a39281706f5e', 'b853f813d', true],
    ['b853f813d', 'b853f813d0e4b2a1c9f8e7d6c5b4a39281706f5e', true],
    ['B853F813D', 'b853f813d', true],
    ['  b853f813d  ', 'b853f813d', true],
    ['b853f81', 'b853f813d', true],
    ['b853f8', 'b853f813d', false],
    ['b853f813d', 'b853f8', false],
    ['b853f813d', 'a12b34c5d', false],
    ['b853f813d', 'not-a-commit', false],
    ['v1.2.3', 'v1.2.3', false],
    ['', '', false],
    ['b853f813d0e4b2a1c9f8e7d6c5b4a39281706f5eff', 'b853f813d', false],
  ])('reads %j against %j as %s', (claimed, live, agree) => {
    expect(commitsAgree(claimed, live)).toBe(agree);
  });
});

describe('verifyServingNow', () => {
  it('accepts the commit the probes are serving, in one read', async () => {
    answers('b853f813d');

    const out = await verifyServingNow({ cfg: CFG, expected: 'b853f813d' });

    expect(out.ok).toBe(true);
    expect(out.ok === true && out.identity).toBe('b853f813d');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a full sha against the abbreviation the probes report', async () => {
    answers('b853f813d');

    const out = await verifyServingNow({
      cfg: CFG,
      expected: 'b853f813d0e4b2a1c9f8e7d6c5b4a39281706f5e',
    });

    expect(out.ok).toBe(true);
  });

  it('refuses a commit the probes are not serving, naming both', async () => {
    answers('a12b34c5d');

    const out = await verifyServingNow({ cfg: CFG, expected: 'b853f813d' });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.identity).toBe('a12b34c5d');
    expect(out.ok === false && out.reason).toContain('a12b34c5d');
    expect(out.ok === false && out.reason).toContain('b853f813d');
  });

  it('refuses an application that is not answering, as a health failure', async () => {
    answers(null);

    const out = await verifyServingNow({ cfg: CFG, expected: 'b853f813d' });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.health).toBe('down');
    expect(out.ok === false && out.reason).toContain('the application is not answering');
  });

  it('refuses a claimed value that is not a commit, rather than comparing it', async () => {
    answers('b853f813d');

    const out = await verifyServingNow({ cfg: CFG, expected: 'HEAD' });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toContain('is not a commit');
  });

  it('carries every probe reading onto the refusal', async () => {
    answers('a12b34c5d');

    const out = await verifyServingNow({ cfg: CFG, expected: 'b853f813d' });

    expect(out.ok === false && out.readings.length).toBe(1);
  });
});

// ISS-1127 — `parseVerifyConfig` takes any non-empty string as a probe url, and
// `readProbe` builds `new URL(probe.url)` outside its own try. So a binding holding
// `"forge-beta-api.sidcorp.co/version"` makes `createReleaseBatch` throw
// `TypeError: Invalid URL` past every mapped refusal, as a 500 with no code, while
// `release-readiness` says nothing about it.
describe('a probe url that does not parse (ISS-1127)', () => {
  const MALFORMED = {
    probes: [{ url: 'forge-beta-api.sidcorp.co/version', commitPath: 'commit' }],
  };

  it('is named by invalidProbeUrls without a request being made', async () => {
    const { invalidProbeUrls } = await import('./verify.js');
    expect(invalidProbeUrls(MALFORMED)).toEqual(['forge-beta-api.sidcorp.co/version']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still throws out of readLiveCommit, which is why the caller has to refuse first', async () => {
    await expect(readLiveCommit(MALFORMED)).rejects.toThrow();
  });
});
