import * as client from 'openid-client';
import { env } from '../../lib/env.js';
import type {
  LoginFinish,
  LoginStart,
  OAuthIdentity,
  OAuthProvider,
  ProviderConfig,
} from './types.js';

const DISCOVERY_TTL_MS = 60 * 60 * 1000;

const configs = new Map<string, { config: Promise<client.Configuration>; fetchedAt: number }>();

/** A plain-http issuer is a local one; anywhere else openid-client's HTTPS-only rule stands. */
function insecureAllowed(issuer: URL): boolean {
  return issuer.protocol === 'http:' && (env.NODE_ENV === 'development' || env.NODE_ENV === 'test');
}

/** Discovery, held for an hour per provider; a failed discovery is not held. */
function configFor(cfg: ProviderConfig): Promise<client.Configuration> {
  if (!cfg.issuerUrl) {
    return Promise.reject(new Error(`oidc: provider ${cfg.id} has no issuerUrl configured`));
  }
  const key = `${cfg.id}|${cfg.issuerUrl}|${cfg.clientId}`;
  const hit = configs.get(key);
  if (hit && Date.now() - hit.fetchedAt < DISCOVERY_TTL_MS) return hit.config;

  const issuer = new URL(cfg.issuerUrl);
  const config = client.discovery(
    issuer,
    cfg.clientId,
    undefined,
    client.ClientSecretPost(cfg.clientSecret),
    insecureAllowed(issuer) ? { execute: [client.allowInsecureRequests] } : undefined,
  );
  configs.set(key, { config, fetchedAt: Date.now() });
  config.catch(() => configs.delete(key));
  return config;
}

async function start(cfg: ProviderConfig, redirectUri: string): Promise<LoginStart> {
  const config = await configFor(cfg);
  const checks = {
    state: client.randomState(),
    nonce: client.randomNonce(),
    codeVerifier: client.randomPKCECodeVerifier(),
  };
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: cfg.scopes.join(' '),
    state: checks.state,
    nonce: checks.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(checks.codeVerifier),
    code_challenge_method: 'S256',
    // Keeps Google's account chooser up even for a single account; other providers ignore it.
    prompt: 'select_account',
  });
  return { url: url.href, checks };
}

async function finish(cfg: ProviderConfig, args: LoginFinish): Promise<OAuthIdentity> {
  const config = await configFor(cfg);
  const tokens = await client.authorizationCodeGrant(config, args.callbackUrl, {
    pkceCodeVerifier: args.checks.codeVerifier,
    expectedState: args.checks.state,
    expectedNonce: args.checks.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims?.sub) throw new Error('oidc: id_token missing sub');

  let email = typeof claims.email === 'string' ? claims.email : null;
  let emailVerified = claims.email_verified === true;

  // Some providers leave email out of the id_token. Userinfo is held to the id_token's subject.
  if ((!email || !emailVerified) && config.serverMetadata().userinfo_endpoint) {
    try {
      const info = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
      const infoEmail = typeof info.email === 'string' ? info.email : null;
      if (!email) email = infoEmail;
      // Userinfo vouches only for the address it names itself.
      if (info.email_verified === true && infoEmail?.toLowerCase() === email?.toLowerCase()) {
        emailVerified = true;
      }
    } catch {
      // Best-effort: the identity stands on the id_token alone.
    }
  }

  return {
    providerAccountId: claims.sub,
    email: email ? email.toLowerCase() : null,
    emailVerified,
  };
}

export const googleProvider: OAuthProvider = { start, finish };
export const oidcProvider: OAuthProvider = { start, finish };
