// How one reading of the probes is taken and what it makes of each answer. Whether the readings a
// release recorded show it live is `reading-judge.test.ts`'s.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseVerifyConfig, readLiveCommit, readLiveState } from './verify.js';

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
  stableReads: 1,
};

describe('parseVerifyConfig', () => {
  it('reads nothing out of a project that declared nothing', () => {
    expect(parseVerifyConfig(undefined)).toBeNull();
    expect(parseVerifyConfig({})).toBeNull();
    expect(parseVerifyConfig({ probes: [] })).toBeNull();
    expect(parseVerifyConfig({ probes: [{ commitPath: 'commit' }] })).toBeNull();
  });

  it('defaults the consecutive readings a finish believes to two', () => {
    const cfg = parseVerifyConfig({ probes: [{ url: 'https://x.test/h' }] });
    expect(cfg?.stableReads).toBe(2);
  });

  it('holds no deadline: a declared timeoutSeconds is not carried', () => {
    const cfg = parseVerifyConfig({ probes: [{ url: 'https://x.test/h' }], timeoutSeconds: 30 });
    expect(cfg).toEqual({
      probes: [{ url: 'https://x.test/h', commitPath: undefined }],
      stableReads: 2,
    });
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
});
