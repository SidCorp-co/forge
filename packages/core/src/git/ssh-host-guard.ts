import { promises as dns } from 'node:dns';
import { isIPv4, isIPv6 } from 'node:net';
import { HTTPException } from 'hono/http-exception';
import { classifyGitRemote } from './provision-credential.js';

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [range = '0.0.0.0', bitsStr = '32'] = cidr.split('/');
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
}

// RFC 1918/5735/6598 private + reserved ranges, plus loopback and link-local
// (169.254.0.0/16 covers the AWS/GCP/Azure metadata address 169.254.169.254).
const PRIVATE_V4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

function isPrivateOrReservedAddress(ip: string): boolean {
  if (isIPv4(ip)) {
    return PRIVATE_V4_CIDRS.some((cidr) => inCidr(ip, cidr));
  }
  if (isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    // fc00::/7 (unique local) and fe80::/10 (link-local)
    if (/^f[cd]/.test(lower)) return true;
    if (/^fe[89ab]/.test(lower)) return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateOrReservedAddress(mapped[1]);
    return false;
  }
  return true; // unrecognised format — fail closed
}

/** Pull the host out of a `git@host:path` or `ssh://host[:port]/path` remote. */
function extractSshHost(repoUrl: string): string | null {
  const trimmed = repoUrl.trim();
  if (trimmed.startsWith('ssh://')) {
    try {
      return new URL(trimmed).hostname || null;
    } catch {
      return null;
    }
  }
  const m = trimmed.match(/^[^@\s]+@([^:\s/]+):/);
  return m?.[1] ?? null;
}

function invalidTransport(): HTTPException {
  return new HTTPException(400, {
    message: 'set an SSH clone URL (git@host:org/repo.git or ssh://host/…)',
    cause: { code: 'INVALID_TRANSPORT' },
  });
}

function hostBlocked(): HTTPException {
  return new HTTPException(400, {
    message: 'that host resolves to a private/internal address and cannot be probed',
    cause: { code: 'SSRF_BLOCKED' },
  });
}

/** A remote's host and the one public address a connection to it must use. */
export interface PinnedSshHost {
  host: string;
  address: string;
}

/** A host name git and ssh may be handed on a command line: letters, digits, dots and dashes. */
const HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

function hostUnresolved(host: string): HTTPException {
  return new HTTPException(400, {
    message: `the repository host ${host} could not be resolved`,
    cause: { code: 'HOST_UNRESOLVED' },
  });
}

/**
 * Resolves `repoUrl`'s host once and returns the address to connect to, refusing an SSH-form
 * check failure, an unresolvable host, or any private/reserved address. The connection must use
 * the returned address (`ssh -o HostName=`): resolving again when ssh connects is a second answer
 * a rebinding DNS server can make private after this one was public.
 */
export async function pinSafeSshHost(repoUrl: string): Promise<PinnedSshHost> {
  if (classifyGitRemote(repoUrl) !== 'ssh') {
    throw invalidTransport();
  }
  const host = extractSshHost(repoUrl);
  if (!host) {
    throw invalidTransport();
  }
  if (isIPv4(host) || isIPv6(host)) {
    if (isPrivateOrReservedAddress(host)) throw hostBlocked();
    return { host, address: host };
  }
  if (!HOST_NAME.test(host)) throw invalidTransport();
  let addresses: string[];
  try {
    addresses = (await dns.lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw hostUnresolved(host);
  }
  const [address] = addresses;
  if (!address) throw hostUnresolved(host);
  if (addresses.some((addr) => isPrivateOrReservedAddress(addr))) {
    throw hostBlocked();
  }
  return { host, address };
}

/** True where `err` is `pinSafeSshHost` finding no address for the host. */
export function isHostUnresolved(err: unknown): boolean {
  return (
    err instanceof HTTPException &&
    (err.cause as { code?: string } | undefined)?.code === 'HOST_UNRESOLVED'
  );
}

/**
 * Throws 400 unless `repoUrl` is an SSH-form remote whose host resolves only
 * to public addresses. An unresolvable host passes, so a connection test can
 * answer `host_unreachable` in its own words.
 */
export async function assertSafeSshRepoUrl(repoUrl: string): Promise<void> {
  try {
    await pinSafeSshHost(repoUrl);
  } catch (err) {
    if (isHostUnresolved(err)) return;
    throw err;
  }
}
