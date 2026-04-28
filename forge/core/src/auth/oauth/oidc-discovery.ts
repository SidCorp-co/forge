/**
 * OIDC discovery + JWKS — shared by Google and the generic OIDC provider.
 *
 * Discovery docs and JWKS keys are cached for 1 hour. `jose`'s
 * `createRemoteJWKSet` does its own internal caching and rotation handling
 * (it refetches when the kid in the JWT header is unknown), so we just
 * wrap it once per issuer.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
}

interface CachedDiscovery {
  doc: DiscoveryDoc;
  jwks: ReturnType<typeof createRemoteJWKSet>;
  fetchedAt: number;
}

const TTL_MS = 60 * 60 * 1000; // 1 hour
const cache = new Map<string, CachedDiscovery>();

function discoveryUrl(issuerUrl: string): string {
  return `${issuerUrl.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

export async function getDiscovery(issuerUrl: string): Promise<CachedDiscovery> {
  const hit = cache.get(issuerUrl);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit;

  const url = discoveryUrl(issuerUrl);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`oidc-discovery: ${url} returned HTTP ${res.status}`);
  }
  const doc = (await res.json()) as DiscoveryDoc;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error(`oidc-discovery: ${url} missing required fields`);
  }
  const jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
  const entry: CachedDiscovery = { doc, jwks, fetchedAt: Date.now() };
  cache.set(issuerUrl, entry);
  return entry;
}

/**
 * Verify an id_token against the issuer's JWKS, audience, and nonce. Returns
 * the verified claims or throws.
 */
export async function verifyIdToken(args: {
  issuerUrl: string;
  idToken: string;
  audience: string;
  nonce?: string;
}): Promise<JWTPayload> {
  const { doc, jwks } = await getDiscovery(args.issuerUrl);
  const { payload } = await jwtVerify(args.idToken, jwks, {
    issuer: doc.issuer,
    audience: args.audience,
  });
  // Discovery's `issuer` is what the spec says we MUST match. `jose` checks
  // it above, but if the discovery doc itself is rotated mid-flight a
  // narrower assertion is cheap insurance.
  if (payload.iss !== doc.issuer) {
    throw new Error(`oidc: id_token issuer ${payload.iss} != discovered ${doc.issuer}`);
  }
  if (args.nonce !== undefined && payload.nonce !== args.nonce) {
    throw new Error('oidc: id_token nonce mismatch');
  }
  return payload;
}

/** Test hook — wipe the cache between unit tests. */
export function __resetDiscoveryCache(): void {
  cache.clear();
}
