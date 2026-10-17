// Who sent a request (ISS-1421 r5): only the X-Forwarded-For entries trusted proxies appended can be
// believed, since the client writes the rest. Too few hops keys everyone by a proxy's address.

import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

function connectionAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address || undefined;
  } catch {
    return undefined;
  }
}

/** The entry `hops` places from the right; a header shorter than that did not cross every trusted
 *  proxy, so it vouches for nothing and the connection's own address answers. */
export function clientAddressFrom(
  forwardedFor: string | undefined,
  connection: string | undefined,
  hops: number,
): string | undefined {
  const appended = (forwardedFor ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .reverse();
  return hops > 0 && appended.length >= hops ? appended[hops - 1] : connection;
}

function entriesIn(forwardedFor: string | undefined): number {
  return (forwardedFor ?? '').split(',').filter((s) => s.trim().length > 0).length;
}

let shapeSaid = false;
let shortSaid = false;

/**
 * What the proxy chain actually sends, said once per process so a deploy's logs show whether the
 * setting fits it: no address is logged, only how many entries arrived against how many are trusted.
 */
export function reportChainShape(forwardedFor: string | undefined, hops: number): void {
  const entries = entriesIn(forwardedFor);
  if (entries === 0) return;
  if (!shapeSaid) {
    shapeSaid = true;
    logger.info(
      { entries, hops },
      `client-ip: the first forwarded request carried ${entries} X-Forwarded-For entries; TRUSTED_PROXY_HOPS=${hops} reads the one ${hops} from the right`,
    );
  }
  if (entries < hops && !shortSaid) {
    shortSaid = true;
    logger.warn(
      { entries, hops },
      `client-ip: X-Forwarded-For carried ${entries} entries, fewer than TRUSTED_PROXY_HOPS=${hops}, so the connection's own address answers, and every client behind the proxy shares it. Set TRUSTED_PROXY_HOPS to the proxies that append to the header, or have the inner proxy trust the outer one`,
    );
  }
}

/** For a test: the next request is reported again, as the first after a restart is. */
export function resetChainShapeReport(): void {
  shapeSaid = false;
  shortSaid = false;
}

export function clientIpOf(c: Context): string | undefined {
  const forwardedFor = c.req.header('x-forwarded-for');
  reportChainShape(forwardedFor, env.TRUSTED_PROXY_HOPS);
  return clientAddressFrom(forwardedFor, connectionAddress(c), env.TRUSTED_PROXY_HOPS);
}
