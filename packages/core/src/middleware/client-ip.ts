// The one reading of who sent a request (ISS-1421 r5). Every proxy in front of core appends the
// address it was reached from to X-Forwarded-For, and the client writes whatever it likes to the
// left of those, so only the entries the trusted proxies appended can be believed. The left-most
// entry this replaced was the client's own word: forging it lifted the register and sign-in rate
// limits on beta (ten registers in six minutes against a limit of three an hour).
//
// The count is the deployment's, set explicitly as `TRUSTED_PROXY_HOPS`, and read the way Express's
// `trust proxy` reads a number: the connection's own address, then X-Forwarded-For from the right,
// skipping one entry per trusted proxy. Too few hops keys everyone by a proxy's address; too many
// lets a forged entry through again.

import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { env } from '../config/env.js';

/** The address the connection came from: the nearest proxy, or the client where none stands. */
function connectionAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address || undefined;
  } catch {
    // A request built in memory (`app.request`) has no socket to read.
    return undefined;
  }
}

/**
 * The client address `hops` trusted proxies vouch for: the connection's own address with no proxy,
 * else the X-Forwarded-For entry `hops` places from the right. A header shorter than that answers its
 * left-most entry, the furthest any proxy saw; with no proxy trusted the header is not read at all.
 */
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
