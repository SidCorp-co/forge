// The failure this exists to catch is not "the site is down". It is "the site
// is up, the deploy reported success, and it is serving the previous build".
// Every case below is a version of that.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseVerifyConfig, readLiveCommit, readLiveState, verifyDeployed } from './verify.js';

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

/** Whole object names. A claim under test may be nothing else. */
const NEW = 'b853f813d0e4b2a1c9f8e7d6c5b4a39281706f5e';
const OLD = 'a12b34c5d6e7f8091a2b3c4d5e6f708192a3b4c5';
const SAME = 'c0ffee1234567890abcdef1234567890abcdef12';
const ELSEWHERE = 'dead0beef1234567890abcdef1234567890abcde';
const FLAP = 'f1a99109876543210fedcba9876543210fedcba9';

const nowFake = () => 0;
const noSleep = async () => undefined;

/**
 * A clock that advances on every read, so a window that CANNOT go green still
 * closes on its own deadline. A frozen clock is only safe where the case is
 * green, and a case asserting a green is exactly the one that has to terminate
 * while the green is still missing.
 */
const ticking = () => {
  let t = 0;
  return () => (t += 600);
};

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
    answers(NEW);

    const out = await verifyDeployed({
      cfg: CFG,
      commitBefore: OLD,
      expected: NEW,
      now: nowFake,
      sleep: noSleep,
    });

    expect(out).toEqual({ ok: true, commit: NEW, health: 'up', identity: NEW, moved: true });
  });

  it('goes red when the site is healthy and still serving the pre-release build', async () => {
    answers(OLD, OLD, OLD, OLD);

    const out = await verifyDeployed({
      cfg: { ...CFG, timeoutSeconds: 1 },
      commitBefore: OLD,
      expected: NEW,
      now: (() => {
        let t = 0;
        return () => (t += 600);
      })(),
      sleep: noSleep,
    });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toContain('unchanged');
  });

  // ISS-1199 — `commitBefore` is read when the batch is OPENED, so a batch
  // opened after its own deploy shipped captured the released commit. This case
  // asserted the contradiction that made of — `live !== commitBefore` against a
  // claim equal to `commitBefore` — as though it were the rule, which is how
  // five identical `finish` attempts each spent 300s proving a constant false.
  it('goes green when the deployment is already serving the commit the release names', async () => {
    answers(SAME, SAME);
    const slept = vi.fn(noSleep);

    const out = await verifyDeployed({
      cfg: { ...CFG, timeoutSeconds: 1 },
      commitBefore: SAME,
      expected: SAME,
      now: ticking(),
      sleep: slept,
    });

    expect(out).toEqual({
      ok: true,
      commit: SAME,
      health: 'up',
      identity: SAME,
      moved: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slept).not.toHaveBeenCalled();
  });

  it('holds an already-serving reading still as long as any other before believing it', async () => {
    answers(SAME, SAME);

    const out = await verifyDeployed({
      cfg: { ...CFG, stableReads: 2, timeoutSeconds: 100 },
      commitBefore: SAME,
      expected: SAME,
      now: ticking(),
      sleep: noSleep,
    });

    expect(out.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still refuses a claim the deployment does not confirm, naming both, when the build never moved', async () => {
    answers(SAME, SAME);

    const out = await verifyDeployed({
      cfg: { ...CFG, timeoutSeconds: 1 },
      commitBefore: SAME,
      expected: NEW,
      now: (() => {
        let t = 0;
        return () => (t += 600);
      })(),
      sleep: noSleep,
    });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toContain(SAME);
    expect(out.ok === false && out.reason).toContain(NEW);
  });

  it('keeps reading for a claimed commit the deployment is not serving yet', async () => {
    answers(OLD, NEW);

    const out = await verifyDeployed({
      cfg: { ...CFG, timeoutSeconds: 100 },
      commitBefore: OLD,
      expected: NEW,
      now: ticking(),
      sleep: noSleep,
    });

    expect(out).toEqual({ ok: true, commit: NEW, health: 'up', identity: NEW, moved: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('goes red where the release claims no commit and the live build never moved', async () => {
    answers(OLD, OLD, OLD, OLD);

    const out = await verifyDeployed({
      cfg: { ...CFG, timeoutSeconds: 1 },
      commitBefore: OLD,
      expected: null,
      now: (() => {
        let t = 0;
        return () => (t += 600);
      })(),
      sleep: noSleep,
    });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toContain('unchanged');
  });

  it('goes red when the live build is not the one the release pushed', async () => {
    answers(ELSEWHERE, ELSEWHERE);

    const out = await verifyDeployed({
      cfg: { ...CFG, timeoutSeconds: 1 },
      commitBefore: OLD,
      expected: NEW,
      now: (() => {
        let t = 0;
        return () => (t += 600);
      })(),
      sleep: noSleep,
    });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toContain(NEW);
  });

  it('accepts a release that reports no commit, as long as the build actually moved', async () => {
    answers(NEW);

    const out = await verifyDeployed({
      cfg: CFG,
      commitBefore: OLD,
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
      commitBefore: OLD,
      expected: NEW,
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
    answers(NEW, FLAP, NEW, NEW);

    const out = await verifyDeployed({
      cfg: { ...CFG, stableReads: 2, timeoutSeconds: 100 },
      commitBefore: OLD,
      expected: null,
      now: nowFake,
      sleep: noSleep,
    });

    expect(out).toEqual({ ok: true, commit: NEW, health: 'up', identity: NEW, moved: true });
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
      commitBefore: OLD,
      expected: NEW,
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
    answers(OLD, OLD, OLD, OLD);

    const out = await runOut(CFG);

    expect(out.ok === false && out.health).toBe('up');
    expect(out.ok === false && out.identity).toBe(OLD);
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

// A host that accepts the connection and never answers. Real sockets, because
// the property is about what `fetch` does when nothing comes back.
describe('a probe that never answers', () => {
  async function silentHost(): Promise<{ url: string; close: () => Promise<void> }> {
    const { createServer } = await import('node:http');
    const server = createServer(() => {});
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as import('node:net').AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/version`,
      close: () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    };
  }

  it('is read as unreachable once its budget runs out', async () => {
    vi.unstubAllGlobals();
    const { readProbe } = await import('./verify.js');
    const host = await silentHost();
    const started = Date.now();
    const reading = await readProbe({ url: host.url }, 300);
    await host.close();
    expect(reading.kind).toBe('unreachable');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('lets a verify window close by its own deadline', async () => {
    vi.unstubAllGlobals();
    const host = await silentHost();
    const started = Date.now();
    const outcome = await verifyDeployed({
      cfg: { probes: [{ url: host.url }], timeoutSeconds: 1, stableReads: 1 },
      commitBefore: null,
      expected: null,
      sleep: async () => {},
    });
    await host.close();
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.health).toBe('down');
    expect(Date.now() - started).toBeLessThan(2_500);
  });
});
