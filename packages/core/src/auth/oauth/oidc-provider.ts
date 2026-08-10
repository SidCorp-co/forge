/**
 * Generic OIDC provider — covers Google + any spec-compliant issuer
 * (Auth0, Authentik, Keycloak, ZITADEL, …).
 *
 * The shape is identical regardless of vendor: discover endpoints, exchange
 * code for tokens (token_endpoint), verify id_token via JWKS, optionally
 * call userinfo_endpoint to fill in email if the id_token didn't carry it.
 *
 * Both `googleProvider` and `oidcProvider` exports below are thin wrappers
 * that point at the same machinery; only the issuer URL changes.
 */

import type { ProviderConfig } from './providers.js';
import { getDiscovery, verifyIdToken } from './oidc-discovery.js';
import type {
  AuthorizeArgs,
  CallbackArgs,
  OAuthIdentity,
  OAuthProvider,
} from './types.js';

interface IdTokenClaims {
  sub?: string;
  email?: string;
  email_verified?: boolean;
}

interface UserInfoResponse {
  sub?: string;
  email?: string;
  email_verified?: boolean;
}

async function buildAuthorizeUrl(
  cfg: ProviderConfig,
  args: AuthorizeArgs,
): Promise<string> {
  if (!cfg.issuerUrl) {
    throw new Error(`oidc: provider ${cfg.id} has no issuerUrl configured`);
  }
  const { doc } = await getDiscovery(cfg.issuerUrl);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: args.redirectUri,
    response_type: 'code',
    scope: cfg.scopes.join(' '),
    state: args.state,
    nonce: args.nonce,
    code_challenge: args.codeChallenge,
    code_challenge_method: 'S256',
    // `select_account` keeps Google's account chooser visible even when the
    // user has only one account; benign on other providers (treated as a
    // no-op `prompt` value or ignored).
    prompt: 'select_account',
  });
  return `${doc.authorization_endpoint}?${params.toString()}`;
}

async function callback(
  cfg: ProviderConfig,
  args: CallbackArgs,
): Promise<OAuthIdentity> {
  if (!cfg.issuerUrl) {
    throw new Error(`oidc: provider ${cfg.id} has no issuerUrl configured`);
  }
  const { doc } = await getDiscovery(cfg.issuerUrl);

  // Token exchange — RFC 6749 application/x-www-form-urlencoded.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  const tokenRes = await fetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new Error(`oidc: token exchange HTTP ${tokenRes.status} — ${text.slice(0, 200)}`);
  }
  const tokens = (await tokenRes.json()) as { access_token?: string; id_token?: string };
  if (!tokens.id_token) {
    throw new Error('oidc: token response missing id_token');
  }

  const claims = (await verifyIdToken({
    issuerUrl: cfg.issuerUrl,
    idToken: tokens.id_token,
    audience: cfg.clientId,
    nonce: args.nonce,
  })) as IdTokenClaims;

  if (!claims.sub) {
    throw new Error('oidc: id_token missing sub');
  }

  let email = claims.email ?? null;
  let emailVerified = claims.email_verified === true;

  // Some providers omit `email` from the id_token and expect us to call
  // userinfo. If we already have a verified email, skip the round-trip.
  if ((!email || !emailVerified) && doc.userinfo_endpoint && tokens.access_token) {
    try {
      const uiRes = await fetch(doc.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
      });
      if (uiRes.ok) {
        const ui = (await uiRes.json()) as UserInfoResponse;
        if (!email && ui.email) email = ui.email;
        if (!emailVerified && ui.email_verified === true) emailVerified = true;
      }
    } catch {
      // userinfo is best-effort; identity is still valid via id_token alone.
    }
  }

  return {
    providerAccountId: claims.sub,
    email: email ? email.toLowerCase() : null,
    emailVerified,
  };
}

export const googleProvider: OAuthProvider = { buildAuthorizeUrl, callback };
export const oidcProvider: OAuthProvider = { buildAuthorizeUrl, callback };
