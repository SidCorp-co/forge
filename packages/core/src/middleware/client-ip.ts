// Who sent a request (ISS-1421 r5), read the way nginx's real_ip and Express's trust proxy read it.
// From the connection, walk back through X-Forwarded-For while the address in hand is a proxy inside
// the deployment: the first address that is not one is the one those proxies vouch for. Where that
// is a Cloudflare edge, the request came through Cloudflare and CF-Connecting-IP names the client.
// Nothing a client writes counts unless a proxy it cannot be vouched for it.

import { BlockList, isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { CLOUDFLARE_RANGES, PRIVATE_PROXY_RANGES } from './cloudflare-ranges.js';

/** Which rule named the client: Cloudflare's header, the address a proxy vouches for, or the socket. */
export type AddressRule = 'cloudflare' | 'proxy' | 'connection';

export interface ClientAddress {
  address: string;
  rule: AddressRule;
}

/** A CIDR list as a matcher; an entry that is not `address/bits` is refused by name. */
export function rangeList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [base, bits] = cidr.trim().split('/');
    const family = isIP(base ?? '');
    const prefix = Number(bits);
    if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
      throw new Error(`client-ip: "${cidr}" is not an address range; write it as address/bits`);
    }
    list.addSubnet(base as string, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}

/** A plain address, with an IPv4 address the socket reports in IPv6 form unwrapped; else null. */
function plain(value: string | undefined): string | null {
  const v = value?.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  return v && isIP(v) ? v : null;
}

function inList(list: BlockList, address: string): boolean {
  return list.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
}

export interface AddressInputs {
  connection: string | undefined;
  forwardedFor: string | undefined;
  cfConnectingIp: string | undefined;
  privateProxies: BlockList;
  cloudflare: BlockList;
}

export function clientAddressFrom(i: AddressInputs): ClientAddress | undefined {
  let address = plain(i.connection);
  if (!address) return undefined;
  let rule: AddressRule = 'connection';
  const chain = (i.forwardedFor ?? '').split(',');
  while (inList(i.privateProxies, address) && chain.length > 0) {
    const vouched = plain(chain.pop());
    // An entry a proxy of ours wrote is an address; anything else stops the walk where it stands.
    if (!vouched) break;
    address = vouched;
    rule = 'proxy';
  }
  if (inList(i.cloudflare, address)) {
    const client = plain(i.cfConnectingIp);
    if (client) return { address: client, rule: 'cloudflare' };
  }
  return { address, rule };
}

const PRIVATE = rangeList(PRIVATE_PROXY_RANGES);
let cloudflare: BlockList | null = null;

function cloudflareList(): BlockList {
  cloudflare ??= rangeList(env.CLOUDFLARE_IP_RANGES ?? CLOUDFLARE_RANGES);
  return cloudflare;
}

function connectionAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address || undefined;
  } catch {
    return undefined;
  }
}

const RULE_WORDS: Record<AddressRule, string> = {
  cloudflare: "Cloudflare's CF-Connecting-IP, the peer being a Cloudflare edge",
  proxy: 'the X-Forwarded-For entry a proxy inside the deployment vouches for',
  connection: "the connection's own address",
};

const said = new Set<string>();

/** Each rule, the first time it names a client in this process, so a deploy's log says which applies. */
export function reportRule(found: ClientAddress | undefined, edgeWithoutHeader: boolean): void {
  if (found && !said.has(found.rule)) {
    said.add(found.rule);
    logger.info(
      { rule: found.rule },
      `client-ip: a client was first read from ${RULE_WORDS[found.rule]}`,
    );
  }
  if (edgeWithoutHeader && !said.has('edge')) {
    said.add('edge');
    logger.warn(
      { rule: found?.rule },
      'client-ip: a request came from a Cloudflare edge with no usable CF-Connecting-IP, so it is counted by the edge address',
    );
  }
}

/** For a test: the next request is reported again, as the first after a restart is. */
export function resetRuleReport(): void {
  said.clear();
}

export function clientIpOf(c: Context): string | undefined {
  const cfConnectingIp = c.req.header('cf-connecting-ip');
  const found = clientAddressFrom({
    connection: connectionAddress(c),
    forwardedFor: c.req.header('x-forwarded-for'),
    cfConnectingIp,
    privateProxies: PRIVATE,
    cloudflare: cloudflareList(),
  });
  const edgeWithoutHeader =
    found !== undefined && found.rule !== 'cloudflare' && inList(cloudflareList(), found.address);
  reportRule(found, edgeWithoutHeader);
  return found?.address;
}
