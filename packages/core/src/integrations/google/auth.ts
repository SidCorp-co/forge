import { createHash } from 'node:crypto';
import { gaxios, JWT } from 'google-auth-library';
import { GoogleAuthError, type ServiceAccountKey } from './types.js';

/** The only token endpoint a key may name; google-auth-library posts the assertion here. */
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const MINT_TIMEOUT_MS = 10_000;

const KEY_SHAPE_REFUSAL =
  'the stored Google credential is not a service-account key file — expected JSON with "type":"service_account", "client_email" and "private_key". Re-enter the key file Google issued, unchanged.';

const FOREIGN_TOKEN_URI_REFUSAL = `the key file's "token_uri" is not Google's. A service-account key issued by Google carries "${DEFAULT_TOKEN_URI}"; anything else would send a signed assertion somewhere Forge will not go. Re-download the key from the Google Cloud console.`;

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

export interface GoogleAccessToken {
  token: string;
  expiresAt: number;
}

function credentialFingerprint(serviceAccountJson: string): string {
  return createHash('sha256').update(serviceAccountJson).digest('hex').slice(0, 16);
}

/** One google-auth-library client per connection, scope and key: its own token cache. */
const clients = new Map<string, JWT>();

export interface MintArgs {
  /** Cache key half. One connection's token is never reused for another. */
  connectionId: string;
  serviceAccountJson: string;
  scope: string;
  /** Skip the cache and exchange a fresh assertion. */
  forceMint?: boolean;
}

function describeMintFailure(err: unknown): GoogleAuthError {
  if (!(err instanceof gaxios.GaxiosError)) {
    // Signing failed before anything was sent: the key itself does not parse.
    return new GoogleAuthError(400, 'rejected', KEY_SHAPE_REFUSAL);
  }
  const status = err.response?.status;
  if (status === undefined) {
    return new GoogleAuthError(
      0,
      'transport',
      `could not reach Google's token endpoint: ${err.message}`,
    );
  }
  if (status === 400 || status === 401 || status === 403) {
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
 * Mint (or reuse) an access token for one connection at one scope. google-auth-library holds it
 * until it nears expiry; `forceMint` builds a fresh client — which is what test-connection uses,
 * so the credential stored NOW is the credential tested rather than whichever one minted the
 * token still sitting in the cache.
 */
export async function googleAccessToken(args: MintArgs): Promise<GoogleAccessToken> {
  const cacheKey = `${args.connectionId}|${args.scope}|${credentialFingerprint(args.serviceAccountJson)}`;
  let jwt = args.forceMint ? undefined : clients.get(cacheKey);
  if (!jwt) {
    const key = parseServiceAccountKey(args.serviceAccountJson);
    jwt = new JWT({
      email: key.client_email,
      key: key.private_key,
      ...(key.private_key_id ? { keyId: key.private_key_id } : {}),
      scopes: [args.scope],
      transporterOptions: { timeout: MINT_TIMEOUT_MS },
    });
  }

  let token: string | null | undefined;
  try {
    ({ token } = await jwt.getAccessToken());
  } catch (err) {
    throw describeMintFailure(err);
  }
  if (!token) throw new GoogleAuthError(200, 'transport', 'Google returned no access_token');
  clients.set(cacheKey, jwt);
  return { token, expiresAt: jwt.credentials.expiry_date ?? Date.now() + 3600_000 };
}
