import { beforeEach, describe, expect, it, vi } from 'vitest';

const info = vi.fn();
const warn = vi.fn();
vi.mock('../logger.js', () => ({ logger: { info, warn } }));

const { clientAddressFrom, reportRule, resetRuleReport } = await import('./client-ip.js');
const { CLOUDFLARE_RANGES, PRIVATE_PROXY_RANGES, rangeList } = await import(
  './cloudflare-ranges.js'
);

// Beta as it stands: Cloudflare, then Coolify's Traefik, which does not trust Cloudflare and so sends
// one X-Forwarded-For entry, the edge's own address. Core is reached from Traefik's container.
const TRAEFIK = '10.0.1.5';
const EDGE = '104.16.0.10';
const EDGE_V6 = '2606:4700::6810:84e5';
const PERSON = '203.0.113.7';

const read = (
  forwardedFor: string | undefined,
  cfConnectingIp?: string,
  connection: string | undefined = TRAEFIK,
) =>
  clientAddressFrom({
    connection,
    forwardedFor,
    cfConnectingIp,
    privateProxies: rangeList(PRIVATE_PROXY_RANGES),
    cloudflare: rangeList(CLOUDFLARE_RANGES),
  });

describe('clientAddressFrom', () => {
  it("names the person Cloudflare says connected, where Traefik vouches the peer is Cloudflare's edge", () => {
    expect(read(EDGE, PERSON)).toEqual({ address: PERSON, rule: 'cloudflare' });
    expect(read(EDGE_V6, '2001:db8::7')).toEqual({ address: '2001:db8::7', rule: 'cloudflare' });
  });

  it('reads the same where Traefik trusts Cloudflare and keeps what it wrote, a forged entry first', () => {
    expect(read(`198.51.100.9, ${PERSON}, ${EDGE}`, PERSON)).toEqual({
      address: PERSON,
      rule: 'cloudflare',
    });
  });

  it('ignores CF-Connecting-IP from a peer that is not a Cloudflare edge', () => {
    expect(read('198.51.100.20', PERSON)).toEqual({ address: '198.51.100.20', rule: 'proxy' });
  });

  it('ignores every X-Forwarded-For entry left of the one a proxy of ours wrote', () => {
    expect(read(`198.51.100.9, ${PERSON}`)).toEqual({ address: PERSON, rule: 'proxy' });
  });

  it('ignores X-Forwarded-For and CF-Connecting-IP sent straight to core from a public address', () => {
    expect(read(PERSON, PERSON, '198.51.100.30')).toEqual({
      address: '198.51.100.30',
      rule: 'connection',
    });
  });

  it('walks back through more than one proxy inside the deployment', () => {
    expect(read(`${PERSON}, 10.0.2.9`)).toEqual({ address: PERSON, rule: 'proxy' });
  });

  it('counts a Cloudflare edge that sent no usable CF-Connecting-IP by the edge address', () => {
    expect(read(EDGE)).toEqual({ address: EDGE, rule: 'proxy' });
    expect(read(EDGE, 'not-an-address')).toEqual({ address: EDGE, rule: 'proxy' });
  });

  it('answers the socket where nothing forwarded the request, an IPv4 socket in IPv6 form unwrapped', () => {
    expect(read(undefined, undefined, '::ffff:127.0.0.1')).toEqual({
      address: '127.0.0.1',
      rule: 'connection',
    });
    const noSocket = clientAddressFrom({
      connection: undefined,
      forwardedFor: PERSON,
      cfConnectingIp: PERSON,
      privateProxies: rangeList(PRIVATE_PROXY_RANGES),
      cloudflare: rangeList(CLOUDFLARE_RANGES),
    });
    expect(noSocket).toBeUndefined();
  });

  it('stops at an entry that is not an address, keeping the proxy that passed it on', () => {
    expect(read('garbage')).toEqual({ address: TRAEFIK, rule: 'connection' });
  });
});

describe('the Cloudflare ranges core ships', () => {
  it('is not empty, and every entry is an address range', () => {
    expect(CLOUDFLARE_RANGES.length).toBeGreaterThan(0);
    expect(() => rangeList(CLOUDFLARE_RANGES)).not.toThrow();
  });

  it('refuses an entry that is not address/bits, by name', () => {
    expect(() => rangeList(['104.16.0.0'])).toThrow(/"104\.16\.0\.0" is not an address range/);
    expect(() => rangeList(['104.16.0.0/40'])).toThrow(/is not an address range/);
    // Consult F2: an empty prefix read as /0, which would have matched every address.
    for (const bad of ['104.16.0.0/', '104.16.0.0/13/extra', '104.16.0.0/ 13']) {
      expect(() => rangeList([bad])).toThrow(/is not an address range/);
    }
  });
});

// The once-per-process line a deploy's log shows, saying which rule named the client.
describe('reportRule', () => {
  beforeEach(() => {
    resetRuleReport();
    info.mockClear();
    warn.mockClear();
  });

  it('says once per rule which one named a client, and no address', () => {
    reportRule({ address: PERSON, rule: 'cloudflare' }, false);
    reportRule({ address: '203.0.113.8', rule: 'cloudflare' }, false);
    reportRule({ address: PERSON, rule: 'proxy' }, false);
    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[0]?.[0]).toEqual({ rule: 'cloudflare' });
    expect(info.mock.calls[0]?.[1]).toMatch(/CF-Connecting-IP/);
    expect(JSON.stringify(info.mock.calls)).not.toContain(PERSON);
  });

  it('warns once where a Cloudflare edge sent no usable CF-Connecting-IP', () => {
    reportRule({ address: EDGE, rule: 'proxy' }, true);
    reportRule({ address: EDGE, rule: 'proxy' }, true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(EDGE);
  });
});
