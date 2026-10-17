import { BlockList, isIP } from 'node:net';

// Cloudflare's edge addresses, as https://www.cloudflare.com/ips-v4 and /ips-v6 published them on
// 2026-10-17. A request whose peer is one of these came through Cloudflare, so its CF-Connecting-IP
// names the client (`packages/core/src/middleware/client-ip.ts`). CLOUDFLARE_IP_RANGES replaces the list where
// Cloudflare has published a newer one before this file is updated.

export const CLOUDFLARE_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

/** Addresses only a proxy inside the deployment holds: loopback, private and link-local. */
export const PRIVATE_PROXY_RANGES: readonly string[] = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

/** A CIDR list as a matcher; an entry that is not exactly `address/bits` is refused by name. */
export function rangeList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const m = /^([^/\s]+)\/(\d{1,3})$/.exec(cidr.trim());
    const family = m ? isIP(m[1] as string) : 0;
    const prefix = Number(m?.[2]);
    if (!m || !family || prefix > (family === 4 ? 32 : 128)) {
      throw new Error(`client-ip: "${cidr}" is not an address range; write it as address/bits`);
    }
    list.addSubnet(m[1] as string, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}
