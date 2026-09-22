/**
 * ISS-1140 — what the door reading says, and what it refuses to say.
 *
 * The pure half: the state a door is in, the status that state produces, and the sentence. The
 * database half — what counts as a delivery, and the turn-away record — is
 * `tests/integration/inbound-door-e2e.test.ts`, because a filter over a table is proved by the
 * table.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ObservedEndpoint } from '../db/schema.js';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { describeInboundDoor, healthWithInboundDoor, inboundDoorState } = await import(
  './inbound-door.js'
);

const HERE = 'https://api.example.test/api/webhooks/in/forge-dev';
const QUIET = {
  accepted: 0,
  lastAcceptedAt: null,
  refusalRecords: 0,
  lastRecordedRefusalAt: null,
  lastRefusalCode: null,
};
const CARRYING = {
  ...QUIET,
  accepted: 7,
  lastAcceptedAt: new Date('2026-09-20T10:00:00.000Z'),
};
const HERE_AND_ON: ObservedEndpoint = {
  url: HERE,
  active: true,
  observedAt: '2026-09-21T00:00:00.000Z',
};
const LOG = "the App's Recent Deliveries tab";

const state = (over: Partial<Parameters<typeof inboundDoorState>[0]> = {}) =>
  inboundDoorState({
    inboundUnprompted: true,
    expectedUrl: HERE,
    observed: HERE_AND_ON,
    traffic: CARRYING,
    ...over,
  });

describe('where a door stands', () => {
  it('is open once something has come through it', () => {
    expect(state()).toBe('open');
  });

  // The state the issue was filed on. Criterion 4.
  it('is silent when it is addressed here and nothing ever has', () => {
    expect(state({ traffic: QUIET })).toBe('silent');
  });

  // The fault that actually happened: GitHub addressed at the web frontend. Criterion 1.
  it('is elsewhere when the provider holds an address that is not this binding s', () => {
    expect(
      state({
        observed: { ...HERE_AND_ON, url: 'https://web.example.test/api/webhooks/in/forge-dev' },
        traffic: CARRYING,
      }),
    ).toBe('elsewhere');
  });

  // Criterion 18 in miniature: the same observed URL, a different binding's expectation.
  it('is elsewhere for a binding whose own project is not the one in the address', () => {
    expect(state({ expectedUrl: 'https://api.example.test/api/webhooks/in/other-project' })).toBe(
      'elsewhere',
    );
  });

  // A trailing slash and a shouting host are the same door to every HTTP client, and calling a
  // binding broken over one would be a false alarm nobody can act on.
  it('reads a trailing slash and a host s case as the same address', () => {
    expect(
      state({
        observed: { ...HERE_AND_ON, url: 'https://API.EXAMPLE.TEST/api/webhooks/in/forge-dev/' },
      }),
    ).toBe('open');
  });

  it('is unaddressed when the provider holds no address', () => {
    expect(state({ observed: { ...HERE_AND_ON, url: null } })).toBe('unaddressed');
    expect(state({ observed: { ...HERE_AND_ON, url: '' } })).toBe('unaddressed');
  });

  // Criterion 3.
  it('is unaddressed when the hook is switched off on the provider s side', () => {
    expect(state({ observed: { ...HERE_AND_ON, active: false } })).toBe('unaddressed');
  });

  // Criterion 17. An `active` the payload did not carry is unknown, not true.
  it('does not read a missing active flag as a hook that is on, nor as one that is off', () => {
    expect(state({ observed: { ...HERE_AND_ON, active: null } })).toBe('open');
    expect(state({ observed: { ...HERE_AND_ON, active: null }, traffic: QUIET })).toBe('silent');
  });

  it('is unreadable when the provider could not be asked', () => {
    expect(
      state({
        observed: { url: null, active: null, observedAt: 'x', readError: 'HTTP 502' },
        traffic: CARRYING,
      }),
    ).toBe('unreadable');
  });

  // Criterion 12. Sentry declares `canReceiveWebhook` and calls only when an error happens.
  it('is not expected for a provider that does not call in unprompted', () => {
    expect(state({ inboundUnprompted: false, traffic: QUIET, observed: null })).toBe(
      'not_expected',
    );
  });

  // Review finding F1, second half. A door nothing has ASKED about has an unknown address, and
  // deliveries recorded earlier say only that it opened once — the URL may have moved since,
  // which is the exact fault this issue was filed on. Traffic never stands in for the check.
  it('is unjudged where nothing has observed the endpoint, whatever the traffic says', () => {
    expect(state({ observed: null, traffic: QUIET })).toBe('unjudged');
    expect(state({ observed: null, traffic: CARRYING })).toBe('unjudged');
  });

  // Review finding F1. A core with no public API origin cannot build the URL this binding needs,
  // so the address half is UNJUDGED — and traffic having come through is not permission to call
  // the unjudged half green, whether or not an observation exists to compare against.
  it('says the address is unjudged where nothing could build the URL this binding needs', () => {
    expect(state({ expectedUrl: null, traffic: CARRYING })).toBe('unjudged');
    expect(state({ expectedUrl: null, traffic: QUIET })).toBe('unjudged');
    expect(state({ expectedUrl: null, observed: null, traffic: CARRYING })).toBe('unjudged');
  });

  // The same absence must not swallow a fault the observation alone establishes.
  it('still names a hook switched off, or held at no address, without an expected URL', () => {
    expect(state({ expectedUrl: null, observed: { ...HERE_AND_ON, active: false } })).toBe(
      'unaddressed',
    );
    expect(
      state({
        expectedUrl: null,
        observed: { url: null, active: null, observedAt: 'x', readError: 'HTTP 502' },
      }),
    ).toBe('unreadable');
  });
});

describe('the status a door state produces', () => {
  it('leaves an open door and an unexpected one exactly as the probe found them', () => {
    expect(healthWithInboundDoor('ok', 'open')).toBe('ok');
    expect(healthWithInboundDoor('ok', 'not_expected')).toBe('ok');
    expect(healthWithInboundDoor(null, 'not_expected')).toBeNull();
  });

  // Criterion 4 and criterion 1 at the status.
  it('refuses to report ok for a door that is silent, elsewhere, unaddressed or unreadable', () => {
    for (const s of ['silent', 'elsewhere', 'unaddressed', 'unreadable', 'unjudged'] as const) {
      expect(healthWithInboundDoor('ok', s)).toBe('degraded');
      expect(healthWithInboundDoor(null, s)).toBe('degraded');
    }
  });

  // Criterion 13. The outbound probe found something an operator must act on FIRST.
  it('passes a worse outbound verdict through rather than replacing it', () => {
    expect(healthWithInboundDoor('needs_reauth', 'silent')).toBe('needs_reauth');
    expect(healthWithInboundDoor('needs_scope', 'elsewhere')).toBe('needs_scope');
    expect(healthWithInboundDoor('error', 'unaddressed')).toBe('error');
    expect(healthWithInboundDoor('degraded', 'silent')).toBe('degraded');
  });
});

describe('what the reading says, and what it does not', () => {
  const read = (over: Partial<Parameters<typeof describeInboundDoor>[0]> = {}) =>
    describeInboundDoor({
      state: 'silent',
      traffic: QUIET,
      expectedUrl: HERE,
      observed: HERE_AND_ON,
      providerDeliveryLog: LOG,
      ...over,
    });

  it('says nothing at all for a provider whose door is not a fact about it', () => {
    expect(read({ state: 'not_expected' })).toBeNull();
  });

  // Criterion 19, and the whole point of the module: it names the read it cannot make.
  it('names the provider s own delivery log rather than asserting that nobody called', () => {
    const sentence = read() ?? '';
    expect(sentence).toContain(LOG);
    expect(sentence).toContain('nothing has ever come through it');
    expect(sentence).not.toMatch(/did not call\.|never called/);
  });

  // Criterion 2 — both URLs, so an operator can see which one to change.
  it('names the address held and the address needed when they differ', () => {
    const sentence =
      read({
        state: 'elsewhere',
        observed: { ...HERE_AND_ON, url: 'https://web.example.test/api/webhooks/in/forge-dev' },
      }) ?? '';
    expect(sentence).toContain('https://web.example.test/api/webhooks/in/forge-dev');
    expect(sentence).toContain(HERE);
  });

  it('tells a hook switched off apart from an App holding no address at all', () => {
    expect(read({ state: 'unaddressed' })).toContain('switched off');
    expect(read({ state: 'unaddressed', observed: { ...HERE_AND_ON, url: null } })).toContain(
      'holds no webhook address',
    );
  });

  // Review finding F1: the missing prerequisite is named, and no provider is blamed for it.
  it('names what is missing where it could not build the URL this binding needs', () => {
    const sentence = read({ state: 'unjudged', expectedUrl: null }) ?? '';
    expect(sentence).toContain('PUBLIC_API_BASE_URL');
    expect(sentence).toContain('the address half of this door is unjudged');
    expect(sentence).not.toMatch(/GitHub|the provider is addressed/);
  });

  it('says the address is unknown, not absent, where nothing has asked the provider yet', () => {
    const sentence = read({ state: 'unjudged', observed: null }) ?? '';
    expect(sentence).toContain('Nothing has asked the provider where it calls in');
    expect(sentence).toContain('say only that it opened once');
    expect(sentence).not.toContain('PUBLIC_API_BASE_URL');
  });

  it('carries the reason a read failed rather than a verdict it did not earn', () => {
    const sentence =
      read({
        state: 'unreadable',
        observed: { url: null, active: null, observedAt: 'x', readError: 'HTTP 502' },
      }) ?? '';
    expect(sentence).toContain('HTTP 502');
    expect(sentence).toContain('nothing here says whether this door is addressed correctly');
  });

  // Criteria 10 and 11. A turned-away call arrived unauthenticated — that is what its signature
  // failing MEANS — so the reading reports the arrival and names nobody.
  it('reports turned-away calls as unauthenticated and attributes them to no sender', () => {
    const sentence =
      read({
        traffic: {
          ...QUIET,
          refusalRecords: 3,
          lastRecordedRefusalAt: new Date('2026-09-21T09:00:00.000Z'),
          lastRefusalCode: 'INVALID_SIGNATURE',
        },
      }) ?? '';
    expect(sentence).toContain('At least 3 calls');
    expect(sentence).toContain('INVALID_SIGNATURE');
    expect(sentence).toContain('unauthenticated, so Forge cannot say who sent it');
    expect(sentence).not.toMatch(/GitHub sent|the provider sent/);
  });

  it('counts one turned-away call in the singular', () => {
    const sentence =
      read({
        traffic: {
          ...QUIET,
          refusalRecords: 1,
          lastRecordedRefusalAt: new Date(0),
          lastRefusalCode: 'X',
        },
      }) ?? '';
    expect(sentence).toContain('At least 1 call carrying');
    expect(sentence).toContain('was turned away');
  });

  // Review finding F3. One record can stand for six calls inside a bucket, so the reading gives a
  // floor and says the last one is the last RECORDED — claiming either exactly would overstate
  // what the deduped row can carry.
  it('gives the turn-aways as a floor and the time as the last one recorded', () => {
    const sentence =
      read({
        traffic: {
          ...QUIET,
          refusalRecords: 1,
          lastRecordedRefusalAt: new Date('2026-09-21T09:00:00.000Z'),
          lastRefusalCode: 'INVALID_SIGNATURE',
        },
      }) ?? '';
    expect(sentence).toContain('at most one per refusal code per ten minutes');
    expect(sentence).toContain('the true count is higher where calls repeated');
    expect(sentence).toContain('The last one RECORDED was at');
  });
});
