/**
 * ISS-1036 — authenticating as a Google service account.
 *
 * Two hops, like the GitHub App path beside it: an assertion signed with the
 * account's own private key proves which account this is, and only that
 * assertion mints the access token every Sheets call carries. No Google SDK —
 * the assertion is `node:crypto` and the exchange is one `fetch`, which is the
 * shape `integrations/github/app-auth.ts` and `integrations/sentry/adapter.ts`
 * already use for their providers.
 */

import { createHash, createSign } from 'node:crypto';
import { GoogleAuthError, type ServiceAccountKey } from './types.js';

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const ASSERTION_LIFETIME_S = 3600;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const MINT_TIMEOUT_MS = 10_000;
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

const KEY_SHAPE_REFUSAL =
  'the stored Google credential is not a service-account key file — expected JSON with "type":"service_account", "client_email" and "private_key". Re-enter the key file Google issued, unchanged.';

// cm:guard `token_uri` is operator-supplied JSON and it is where core POSTs a SIGNED assertion, so an unchecked value is an SSRF door a project admin can open — and worse than a plain one, because the request carries a credential this deployment minted. Refuse a foreign host by name rather than quietly substituting Google's: a key file pointing somewhere else is not a key file with a stray field, it is a different credential than the operator thinks they pasted.
const FOREIGN_TOKEN_URI_REFUSAL = `the key file's "token_uri" is not Google's. A service-account key issued by Google carries "${DEFAULT_TOKEN_URI}"; anything else would send a signed assertion somewhere Forge will not go. Re-download the key from the Google Cloud console.`;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Read the stored key file. Refuses by name rather than returning a half-built
 * key: a credential that cannot be parsed is an operator's to replace, and the
 * message is the only thing that says so.
 */
export function parseServiceAccountKey(json: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new GoogleAuthError(400, 'rejected', KEY_SHAPE_REFUSAL);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GoogleAuthError(400, 'rejected', KEY_SHAPE_REFUSAL);
  }
  const key = parsed as Record<string, unknown>;
  if (
    key.type !== 'service_account' ||
    typeof key.client_email !== 'string' ||
    key.client_email.length === 0 ||
    typeof key.private_key !== 'string' ||
    !key.private_key.includes('PRIVATE KEY')
  ) {
    throw new GoogleAuthError(400, 'rejected', KEY_SHAPE_REFUSAL);
  }
  if (key.token_uri !== undefined && key.token_uri !== DEFAULT_TOKEN_URI) {
    throw new GoogleAuthError(400, 'rejected', FOREIGN_TOKEN_URI_REFUSAL);
  }
  return key as unknown as ServiceAccountKey;
}

// cm:guard `iat` is backdated by 60 seconds on purpose — Google rejects an assertion whose `iat` sits in its own future, which is what a box with a clock a few seconds fast produces, and it presents as an unexplained invalid_grant on a credential that is fine. The same backdating is on `integrations/github/app-auth.ts` for the same reason.
export function buildAssertion(
  key: ServiceAccountKey,
  scope: string,
  nowMs: number = Date.now(),
): string {
  const now = Math.floor(nowMs / 1000);
  // The constant and not `key.token_uri`: `parseServiceAccountKey` has already
  // refused any other value, so reading the field back would be a second,
  // weaker copy of that rule.
  const aud = DEFAULT_TOKEN_URI;
  const header = b64url(
    JSON.stringify({
      alg: 'RS256',
      typ: 'JWT',
      ...(key.private_key_id ? { kid: key.private_key_id } : {}),
    }),
  );
  const payload = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope,
      aud,
      iat: now - 60,
      exp: now - 60 + ASSERTION_LIFETIME_S,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign(key.private_key).toString('base64url')}`;
}

export interface GoogleAccessToken {
  token: string;
  expiresAt: number;
}

// cm:guard the cache key carries a fingerprint of the KEY FILE, not just the connection and scope. A connection rotated from account A to account B keeps its id, so a key of (connectionId, scope) hands back A's token for the rest of its hour and every read and write runs as the account the operator just replaced.
function credentialFingerprint(serviceAccountJson: string): string {
  return createHash('sha256').update(serviceAccountJson).digest('hex').slice(0, 16);
}

const cache = new Map<string, GoogleAccessToken>();

/** Test-only — drops every cached token so a suite starts from a cold mint. */
export function __resetGoogleTokenCache(): void {
  cache.clear();
}

export interface MintArgs {
  /** Cache key half. One connection's token is never reused for another. */
  connectionId: string;
  serviceAccountJson: string;
  scope: string;
  /** Skip the cache and exchange a fresh assertion. */
  forceMint?: boolean;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}

/** What the token endpoint returns on the happy path. */
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

function describeTokenFailure(status: number): GoogleAuthError {
  // cm:guard Google's own error body is NOT echoed to the caller — it is a third party's response and has carried the assertion back in `error_description` on a malformed grant. The status and a sentence Forge wrote are what a caller gets (the same rule the Coolify log path states).
  const rejected = status === 400 || status === 401 || status === 403;
  if (rejected) {
    return new GoogleAuthError(
      status,
      'rejected',
      'Google refused the service-account credential — the key was revoked, the account was deleted, or the key file is not the one Google issued. Re-enter the key file from the Google Cloud console.',
    );
  }
  return new GoogleAuthError(
    status,
    'transport',
    `Google's token endpoint answered HTTP ${status}`,
  );
}

/**
 * Mint (or reuse) an access token for one connection at one scope. Google
 * issues these for an hour; the cache hands one back until a minute before it
 * lapses, and `forceMint` bypasses that — which is what test-connection uses,
 * so the credential stored NOW is the credential tested rather than whichever
 * one minted the token still sitting in the cache.
 */
export async function googleAccessToken(args: MintArgs): Promise<GoogleAccessToken> {
  const now = args.nowMs ?? Date.now();
  const cacheKey = `${args.connectionId}|${args.scope}|${credentialFingerprint(args.serviceAccountJson)}`;
  if (!args.forceMint) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) return hit;
  }

  const key = parseServiceAccountKey(args.serviceAccountJson);
  const doFetch = args.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(DEFAULT_TOKEN_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: JWT_BEARER_GRANT,
        assertion: buildAssertion(key, args.scope, now),
      }).toString(),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GoogleAuthError(
      0,
      'transport',
      `could not reach Google's token endpoint: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }

  if (!res.ok) throw describeTokenFailure(res.status);

  const body = (await res.json()) as TokenResponse;
  if (!body.access_token) {
    throw new GoogleAuthError(res.status, 'transport', 'Google returned no access_token');
  }
  const minted: GoogleAccessToken = {
    token: body.access_token,
    expiresAt: now + (body.expires_in ?? 3600) * 1000,
  };
  cache.set(cacheKey, minted);
  return minted;
}
