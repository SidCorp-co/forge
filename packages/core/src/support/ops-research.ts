// One public web page, read for a role granted `research` (REQ-75 BC-24). Core reads it, not the
// session: the session's box runs confined to core and the model gateway, and a role's grant is
// enforced where the bytes are fetched. Only https on port 443, only a host whose every address is
// public (no loopback, private, link-local, carrier-grade NAT, multicast or reserved range), connected
// to the address that was checked so a second lookup cannot swap it, no redirect followed, and the
// page cut to text of a bounded length.

import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { OPERATIONS_RESEARCH_MAX_CHARS } from '@forge/contracts/support-operations';
import { no, type Outcome } from './outcome.js';

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1_000_000;

/** Every range a public page is never served from. */
const NOT_PUBLIC = (() => {
  const list = new BlockList();
  for (const [net, bits] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    list.addSubnet(net, bits, 'ipv4');
  }
  for (const [net, bits] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['100::', 64],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) {
    list.addSubnet(net, bits, 'ipv6');
  }
  return list;
})();

export function isPublicAddress(address: string): boolean {
  // an IPv4 address written as IPv6 is judged as the IPv4 address it is; a hex-written one is refused
  const mapped = /^::ffff:(.+)$/i.exec(address);
  if (mapped) return isIP(mapped[1] ?? '') === 4 && isPublicAddress(mapped[1] ?? '');
  const family = isIP(address);
  if (family === 0) return false;
  return !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** A page's visible words: scripts, styles and tags dropped, entities read, whitespace folded. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\f\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n\n+/g, '\n')
    .trim();
}

const refused = (detail: string): Outcome<never> => no('OPS_RESEARCH_REFUSED', '/url', detail);

export interface ResearchPage {
  url: string;
  status: number;
  text: string;
  truncated: boolean;
}

/** The page at `raw`, as text, or the refusal naming why it was not read. */
export async function readPublicPage(raw: string): Promise<Outcome<ResearchPage>> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refused(`${raw} is not a URL`);
  }
  if (url.protocol !== 'https:') return refused('only an https page is read');
  if (url.port && url.port !== '443') return refused('only an https page on port 443 is read');
  if (url.username || url.password) return refused('a URL carrying credentials is not read');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) return refused(`${host} does not resolve`);
  const inside = addresses.find((a) => !isPublicAddress(a.address));
  if (inside)
    return refused(`${host} resolves to ${inside.address}, which is not a public address`);
  const target = addresses[0] as { address: string; family: number };
  return new Promise((resolve) => {
    const req = request(
      url,
      {
        method: 'GET',
        timeout: TIMEOUT_MS,
        headers: { accept: 'text/html, text/plain;q=0.9', 'user-agent': 'Forge research' },
        // connect to the address just checked, never to a second answer for the same name
        lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
          o.all
            ? cb(null, [{ address: target.address, family: target.family }])
            : cb(null, target.address, target.family)) as never,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve(
            refused(
              `${url.href} redirects (${status}) to ${res.headers.location ?? 'nowhere'}; a redirect is not followed, ask for that page itself`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('close', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const kind = String(res.headers['content-type'] ?? '');
          const text = kind.includes('html') ? pageText(body) : body.trim();
          resolve({
            ok: true,
            value: {
              url: url.href,
              status,
              text: text.slice(0, OPERATIONS_RESEARCH_MAX_CHARS),
              truncated: text.length > OPERATIONS_RESEARCH_MAX_CHARS || size > MAX_BYTES,
            },
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve(refused(`${url.href} could not be read: ${err.message}`)));
    req.end();
  });
}
