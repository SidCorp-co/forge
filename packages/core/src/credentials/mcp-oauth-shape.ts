import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  MCP_OAUTH_CODE_PREFIX,
  MCP_OAUTH_REFRESH_PREFIX,
  MCP_OAUTH_SCOPES,
  type McpOAuthScope,
} from '@forge/contracts/mcp-auth';
import { digestToken } from '../lib/token-digest.js';

/**
 * The pure rules of the MCP OAuth flow: which redirect URIs a client may register and use, how a
 * PKCE verifier answers its challenge, the scope grammar, and the secrets' shape. No I/O here, so
 * each rule is tested on its own (`mcp-oauth-shape.test.ts`).
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Why a redirect URI cannot be registered, or null when it can. */
export function redirectUriFault(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${raw} is not an absolute URL`;
  }
  if (url.hash) return `${raw} carries a fragment, which a redirect URI may not (RFC 6749 §3.1.2)`;
  if (url.username || url.password) return `${raw} carries credentials`;
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return null;
  return `${raw} is neither https nor http on a loopback host (localhost, 127.0.0.1, [::1])`;
}

/**
 * Whether `asked` is one of the registered URIs. A loopback URI matches whatever its port, since a
 * native client binds a free port each time it listens (RFC 8252 §7.3); every other URI matches
 * exactly.
 */
export function redirectUriRegistered(asked: string, registered: readonly string[]): boolean {
  if (registered.includes(asked)) return true;
  let url: URL;
  try {
    url = new URL(asked);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) return false;
  const portless = (u: URL) => `${u.protocol}//${u.hostname}${u.pathname}${u.search}`;
  return registered.some((r) => {
    try {
      return portless(new URL(r)) === portless(url);
    } catch {
      return false;
    }
  });
}

/** A PKCE S256 challenge: 43 base64url characters, the SHA-256 of a verifier (RFC 7636 §4.2). */
export const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** A PKCE verifier: 43 to 128 unreserved characters (RFC 7636 §4.1). */
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** Whether `verifier` answers the S256 `challenge`, compared in constant time. */
export function pkceAnswers(verifier: string, challenge: string): boolean {
  if (!CODE_VERIFIER.test(verifier) || !CODE_CHALLENGE.test(challenge)) return false;
  const computed = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/** The scopes a space-separated `scope` names, or the name of the first one that is not a scope. */
export function parseScope(
  raw: string | undefined,
): { scopes: McpOAuthScope[] } | { unknown: string } {
  if (raw === undefined || raw.trim() === '') return { scopes: [...MCP_OAUTH_SCOPES] };
  const scopes: McpOAuthScope[] = [];
  for (const part of raw.trim().split(/\s+/)) {
    if (!(MCP_OAUTH_SCOPES as readonly string[]).includes(part)) return { unknown: part };
    if (!scopes.includes(part as McpOAuthScope)) scopes.push(part as McpOAuthScope);
  }
  return { scopes };
}

/** A fresh secret of one kind: the prefix the scrubber knows, then 256 random bits. */
export function mintSecret(kind: 'code' | 'refresh'): { plaintext: string; hash: string } {
  const prefix = kind === 'code' ? MCP_OAUTH_CODE_PREFIX : MCP_OAUTH_REFRESH_PREFIX;
  const plaintext = `${prefix}${randomBytes(32).toString('base64url')}`;
  return { plaintext, hash: digestToken(plaintext) };
}

/** The redirect URI with these parameters added, its own query kept. */
export function redirectWith(redirectUri: string, params: Record<string, string | undefined>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}
