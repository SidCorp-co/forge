// Who sent a request (ISS-1421 r5): only the X-Forwarded-For entries trusted proxies appended can be
// believed, since the client writes the rest. Too few hops keys everyone by a proxy's address.

import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { env } from '../config/env.js';

function connectionAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address || undefined;
  } catch {
    return undefined;
  }
}

/** Read as Express's numeric `trust proxy`; a header shorter than `hops` answers its left-most entry. */
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
  const chain = [connection, ...appended];
  const at = Math.min(hops, chain.length - 1);
  return chain[at];
}

export function clientIpOf(c: Context): string | undefined {
  return clientAddressFrom(
    c.req.header('x-forwarded-for'),
    connectionAddress(c),
    env.TRUSTED_PROXY_HOPS,
  );
}
