// The git relay (REQ-73 BC-5): a box reaches a relayed source host's repository through Forge, never
// with the connection's credential. A checkout's origin is a Forge URL (`gitRelayUrlFor`), the box's
// credential helper is handed a relay ticket for it (an HS256 JWT core minted for ONE device and ONE
// binding, under its own issuer so it verifies as nothing else), and core adds the host's credential
// to each relayed request. A ticket lasts an hour; whether its device may still reach the repository
// is decided again on every request, so a binding switched off stops git at once.

import { jwtVerify, SignJWT } from 'jose';
import { env } from '../../lib/env.js';
import { resolveApiBaseUrl } from '../index.js';

const ALG = 'HS256';
const ISSUER = 'forge.git.relay';
/** As long as a GitHub installation token: git re-asks the helper once it runs out. */
export const GIT_RELAY_TICKET_SECONDS = 60 * 60;

/** Where every relayed repository lives under core's public API origin. */
export const GIT_RELAY_PREFIX = 'api/git';

let cachedKey: Uint8Array | null = null;
const key = (): Uint8Array => {
  cachedKey ??= new TextEncoder().encode(env.JWT_SECRET);
  return cachedKey;
};

export interface GitRelayGrant {
  deviceId: string;
  bindingId: string;
}

export function signGitRelayTicket(grant: GitRelayGrant, now = Date.now()): Promise<string> {
  return new SignJWT({ bid: grant.bindingId })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setSubject(grant.deviceId)
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(now / 1000) + GIT_RELAY_TICKET_SECONDS)
    .sign(key());
}

export async function readGitRelayTicket(
  token: string,
  now = Date.now(),
): Promise<GitRelayGrant | null> {
  try {
    const { payload } = await jwtVerify(token, key(), {
      issuer: ISSUER,
      algorithms: [ALG],
      currentDate: new Date(now),
    });
    if (typeof payload.bid !== 'string' || typeof payload.sub !== 'string') return null;
    return { deviceId: payload.sub, bindingId: payload.bid };
  } catch {
    return null;
  }
}

/** Core's public API origin, or null where it knows none and so can relay nothing. */
const relayBase = (): string | null => resolveApiBaseUrl();

/** The Forge URL a relayed repository is cloned, fetched and pushed through; null without a public origin. */
export function gitRelayUrlFor(host: string, repositoryPath: string): string | null {
  const base = relayBase();
  const path = repositoryPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  return base ? `${base}/${GIT_RELAY_PREFIX}/${host.toLowerCase()}/${path}.git` : null;
}

/**
 * The relayed repository a credential ask names: git asks for core's own host and a path under the
 * relay prefix. Null for any other ask, which is a host git reaches directly.
 */
export function relayedAskOf(host: string, path: string): { host: string; path: string } | null {
  const base = relayBase();
  if (!base || new URL(base).host.toLowerCase() !== host.toLowerCase()) return null;
  const basePath = new URL(base).pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  const prefix = [basePath, GIT_RELAY_PREFIX].filter(Boolean).join('/');
  const trimmed = path.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed.startsWith(`${prefix}/`)) return null;
  const [upstreamHost, ...rest] = trimmed.slice(prefix.length + 1).split('/');
  const repo = rest.join('/').replace(/\.git$/i, '');
  return upstreamHost && repo.includes('/') ? { host: upstreamHost, path: repo } : null;
}

/** git's smart-HTTP requests, the only ones the relay passes: discovery, fetch and push. */
export type GitRelayService = 'git-upload-pack' | 'git-receive-pack';

export interface GitRelayRequest {
  /** The repository's path on its host, without `.git`. */
  repository: string;
  /** What follows `.git/` on the host, as git sent it. */
  suffix: 'info/refs' | GitRelayService;
  service: GitRelayService;
}

const SERVICES: readonly GitRelayService[] = ['git-upload-pack', 'git-receive-pack'];
const isService = (s: string | undefined): s is GitRelayService =>
  SERVICES.includes(s as GitRelayService);

/**
 * Which smart-HTTP request a relayed path and method are, or null for anything else: the dumb
 * protocol, a browse, a path with no repository in it.
 */
export function gitRelayRequestOf(
  method: string,
  rest: string,
  service: string | undefined,
): GitRelayRequest | null {
  const m = /^(.+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/i.exec(rest);
  if (!m?.[1] || !m[2] || !m[1].includes('/')) return null;
  const suffix = m[2].toLowerCase();
  if (suffix === 'info/refs') {
    return method === 'GET' && isService(service)
      ? { repository: m[1], suffix: 'info/refs', service }
      : null;
  }
  return method === 'POST' && isService(suffix)
    ? { repository: m[1], suffix, service: suffix }
    : null;
}
