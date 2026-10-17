import { beforeEach, describe, expect, it, vi } from 'vitest';

const info = vi.fn();
const warn = vi.fn();
vi.mock('../logger.js', () => ({ logger: { info, warn } }));

const { clientAddressFrom, reportChainShape, resetChainShapeReport } = await import(
  './client-ip.js'
);

// Beta's shape: the client, then Cloudflare's edge (appended by Traefik), and Traefik itself as the
// connection core is reached on.
const TRAEFIK = '10.0.1.5';
const EDGE = '172.70.1.1';
const CLIENT = '203.0.113.7';

describe('clientAddressFrom', () => {
  it('takes the entry the trusted proxies appended, never what the client wrote to their left', () => {
    expect(clientAddressFrom(`198.51.100.9, ${CLIENT}, ${EDGE}`, TRAEFIK, 2)).toBe(CLIENT);
    expect(clientAddressFrom(`${CLIENT}, ${EDGE}`, TRAEFIK, 2)).toBe(CLIENT);
  });

  it('reads one entry from the right behind a single proxy', () => {
    expect(clientAddressFrom(`198.51.100.9, ${CLIENT}`, TRAEFIK, 1)).toBe(CLIENT);
  });

  it('reads no header at all where no proxy is trusted', () => {
    expect(clientAddressFrom(`198.51.100.9, ${CLIENT}`, TRAEFIK, 0)).toBe(TRAEFIK);
    expect(clientAddressFrom(`198.51.100.9`, undefined, 0)).toBeUndefined();
  });

  // A header shorter than the hops did not cross every trusted proxy, so the caller wrote some of it.
  it('answers the connection where the header is shorter than the hops', () => {
    expect(clientAddressFrom('198.51.100.9', TRAEFIK, 2)).toBe(TRAEFIK);
    expect(clientAddressFrom(undefined, TRAEFIK, 2)).toBe(TRAEFIK);
    expect(clientAddressFrom('198.51.100.9', undefined, 2)).toBeUndefined();
  });

  it('ignores blank entries and spaces a proxy left', () => {
    expect(clientAddressFrom(` , ${CLIENT} ,  ${EDGE} `, TRAEFIK, 2)).toBe(CLIENT);
  });
});

// ISS-1421 r5 repair 1: whether the default fits a deploy's proxy chain cannot be read before it
// runs, so the first forwarded request says what arrived, and a chain shorter than the setting says
// the limits key every client by one address.
describe('reportChainShape', () => {
  beforeEach(() => {
    resetChainShapeReport();
    info.mockClear();
    warn.mockClear();
  });

  it('says once how many entries the first forwarded request carried, and no address', () => {
    reportChainShape(`${CLIENT}, ${EDGE}`, 2);
    reportChainShape(`${CLIENT}, ${EDGE}`, 2);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toEqual({ entries: 2, hops: 2 });
    expect(JSON.stringify(info.mock.calls)).not.toContain(CLIENT);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once where the chain is shorter than the setting, as Traefik sends it when it does not trust Cloudflare', () => {
    reportChainShape(EDGE, 2);
    reportChainShape(EDGE, 2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatch(/fewer than TRUSTED_PROXY_HOPS=2/);
  });

  // Consult F1: a proxy that sent the header empty was as silent as one that sent none.
  it.each(['', ' , '])('warns once for a header %j a proxy sent with no entry in it', (header) => {
    reportChainShape(header, 2);
    reportChainShape(header, 2);
    expect(info.mock.calls[0]?.[0]).toEqual({ entries: 0, hops: 2 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatch(/carried 0 X-Forwarded-For entries, fewer than/);
  });

  it('says nothing for a request no proxy forwarded', () => {
    reportChainShape(undefined, 2);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
