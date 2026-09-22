// What the deployment reports is the identity; what the caller sends is a claim
// under test. These suites are about the line between the two — `verify.test.ts`
// is about whether a deploy arrived at all.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deploymentConfirms, verifyDeployed, verifyServingNow } from './verify.js';

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
/** The abbreviation a deployment may report of NEW. */
const SHORT = 'b853f813d';

const nowFake = () => 0;
const noSleep = async () => undefined;

// `deploymentConfirms` and `verifyServingNow` answer a different question from
// `verifyDeployed`: not "did the deploy I just started arrive" but "is the
// application serving this commit right now". One read, no poll, and a
// comparison that tolerates the abbreviation production reports without
// tolerating an abbreviation the caller chose.

describe('deploymentConfirms', () => {
  it.each([
    [NEW, NEW, true],
    [NEW, SHORT, true],
    [NEW.toUpperCase(), SHORT, true],
    [`  ${NEW}  `, SHORT, true],
    [NEW, 'b853f81', true],
    // The claim is the value under test, so it may not abbreviate: each of these
    // would be confirmed by every commit it prefixes (ISS-1161).
    [SHORT, NEW, false],
    ['b853f81', NEW, false],
    ['b853f813d', 'b853f813d', false],
    [NEW, 'b853f8', false],
    [NEW, OLD, false],
    [NEW, 'not-a-commit', false],
    ['v1.2.3', 'v1.2.3', false],
    ['', '', false],
    [`${NEW}ff`, SHORT, false],
  ])('reads the claim %j against the reading %j as %s', (claimed, reported, agree) => {
    expect(deploymentConfirms(claimed, reported)).toBe(agree);
  });
});

// Measured 2026-09-21. A judging run wrote a release record against sid-desk
// meaning to watch it be refused, claimed `6D3F607`, and that was a seven-digit
// prefix of what the deployment was serving — so it verified, and ISS-393 closed
// on a project nobody was working. The claim is planted here whole.
describe('the accidental verification of 2026-09-21 (ISS-1161)', () => {
  const SERVING = '6d3f607a1b2c3d4e5f60718293a4b5c6d7e8f900';

  it('refuses the seven-character prefix that closed ISS-393, naming the rule', async () => {
    answers(SERVING);

    const out = await verifyServingNow({ cfg: CFG, expected: '6D3F607' });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toContain('is not a whole commit');
    expect(out.ok === false && out.reason).toContain('40 hexadecimal characters');
    expect(out.ok === false && out.reason).toContain('prefix of');
  });

  it('names what the deployment reports, so the caller can retry from the refusal', async () => {
    answers(SERVING);

    const out = await verifyServingNow({ cfg: CFG, expected: '6D3F607' });

    expect(out.ok === false && out.reason).toContain(SERVING);
    expect(out.ok === false && out.identity).toBe(SERVING);
  });
});

describe('verifyServingNow', () => {
  it('accepts the whole sha the probes are serving, in one read', async () => {
    answers(NEW);

    const out = await verifyServingNow({ cfg: CFG, expected: NEW });

    expect(out.ok).toBe(true);
    expect(out.ok === true && out.identity).toBe(NEW);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a whole sha against the abbreviation the probes report', async () => {
    answers(SHORT);

    const out = await verifyServingNow({ cfg: CFG, expected: NEW });

    expect(out.ok).toBe(true);
    expect(out.ok === true && out.identity).toBe(SHORT);
  });

  it('refuses a whole sha the probes are not serving, naming both', async () => {
    answers(OLD);

    const out = await verifyServingNow({ cfg: CFG, expected: NEW });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.identity).toBe(OLD);
    expect(out.ok === false && out.reason).toContain(OLD);
    expect(out.ok === false && out.reason).toContain(NEW);
  });

  it('refuses an application that is not answering, as a health failure', async () => {
    answers(null);

    const out = await verifyServingNow({ cfg: CFG, expected: NEW });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.health).toBe('down');
    expect(out.ok === false && out.reason).toContain('the application is not answering');
  });

  it.each([['{}'], ['{"commit":null}'], ['{"commit":""}']])(
    'refuses a deployment whose commit path holds no string: %s',
    async (body) => {
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => body });

      const out = await verifyServingNow({ cfg: CFG, expected: NEW });

      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toContain('no probe reported a commit');
    },
  );

  it('refuses a claimed value that is not a commit, rather than comparing it', async () => {
    answers(NEW);

    const out = await verifyServingNow({ cfg: CFG, expected: 'HEAD' });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toContain('is not a whole commit');
  });

  it('carries every probe reading onto the refusal', async () => {
    answers(OLD);

    const out = await verifyServingNow({ cfg: CFG, expected: NEW });

    expect(out.ok === false && out.readings.length).toBe(1);
  });
});

// The batch door closes issues too, so it reads a claim by the same rule. It
// asked `live === expected`, which took the deployment's own abbreviation back
// from the caller as proof and refused the whole sha the abbreviation stood for.
describe('verifyDeployed reads a claim by the same rule (ISS-1161)', () => {
  it('accepts a whole sha against the abbreviation the probes report', async () => {
    answers(SHORT);

    const out = await verifyDeployed({
      cfg: CFG,
      commitBefore: OLD,
      expected: NEW,
      now: nowFake,
      sleep: noSleep,
    });

    expect(out.ok).toBe(true);
    expect(out.ok === true && out.identity).toBe(SHORT);
  });

  it('refuses a claim that is not a whole sha after one read, without sleeping', async () => {
    answers(SHORT);
    const slept = vi.fn(noSleep);

    const out = await verifyDeployed({
      cfg: CFG,
      commitBefore: OLD,
      expected: SHORT,
      now: nowFake,
      sleep: slept,
    });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toContain('is not a whole commit');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slept).not.toHaveBeenCalled();
  });

  it('still asks only that the deploy arrived where the caller claims nothing', async () => {
    answers(SHORT);

    const out = await verifyDeployed({
      cfg: CFG,
      commitBefore: OLD,
      expected: null,
      now: nowFake,
      sleep: noSleep,
    });

    expect(out.ok).toBe(true);
  });
});
