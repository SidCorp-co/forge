// Cloudflare's edge addresses, as https://www.cloudflare.com/ips-v4 and /ips-v6 published them on
// 2026-10-17. A request whose peer is one of these came through Cloudflare, so its CF-Connecting-IP
// names the client (`middleware/client-ip.ts`). CLOUDFLARE_IP_RANGES replaces the list where
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
